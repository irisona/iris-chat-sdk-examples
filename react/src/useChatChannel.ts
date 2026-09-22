import { useCallback, useEffect, useRef, useState } from "react";
import {
  Iris,
  type AudioPlayerState,
  type ChatChannel,
  type ChatChannelState,
  type ChatMode,
  type Credential,
  type MediaAttachment,
  type ToolUsePayload,
  type User
} from "@irisona/chat-sdk";

export type CaptionWord = { text: string; startMs: number; durationMs: number };

export type Message = {
  id: string;
  role: "user" | "persona" | "system";
  text: string;
  mediaAttachments?: MediaAttachment[];
  // Present once this bubble starts being read aloud — see subtitle_chunk below. `text` (from
  // persona_message(_chunk)) is still the full message and always renders; these words are only
  // used to highlight the currently-spoken word within that text.
  karaokeWords?: CaptionWord[];
  // Set on the locally-added bubble for a "continuation" intent — unlike "reply", the wire never
  // echoes it back and the SDK doesn't synthesize a user_message event for it, so this is the only
  // record of it. Flagged so the widget can style it apart from a normal user reply.
  isContinuation?: boolean;
};

// api.irisona.net/v1/users/me — not part of the SDK's public API, called directly here just to
// show who a pasted bearer token belongs to. Iris.getCurrentUser() only reflects Iris.authorize(),
// and that flow's backend endpoint (POST /v1/auth/sessions) doesn't exist yet.
export const USER_DETAIL_URL = "https://api.irisona.net/v1/users/me";

function upsertPersonaMessage(
  messages: Message[],
  id: string,
  text: string,
  replace: boolean,
  mediaAttachments?: MediaAttachment[]
): Message[] {
  const index = messages.findIndex((m) => m.role === "persona" && m.id === id);

  if (index === -1) {
    return [...messages, { id, role: "persona", text, mediaAttachments }];
  }

  const next = [...messages];
  next[index] = {
    ...next[index],
    text: replace ? text : next[index].text + text,
    mediaAttachments: mediaAttachments ?? next[index].mediaAttachments
  };

  return next;
}

function describeToolUse(payload: ToolUsePayload): string {
  switch (payload.name) {
    case "image_generation":
    case "erotic_image_generation":
      return "🖼️ image generated";
    case "video_generation":
      return `🎬 video ${payload.status ?? "generating"}`;
    case "soundtrack_generation":
      return "🎵 soundtrack generated";
    case "voice_generation":
      return "🎙️ voices generated";
    case "avatar_change":
      return "🧑 avatar updated";
    default:
      return `🔧 ${payload.name}`;
  }
}

async function fetchCurrentUser(token: string): Promise<string> {
  try {
    const res = await fetch(USER_DETAIL_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return `token invalid (${res.status})`;

    const data = await res.json();
    return `${data.user?.name ?? "unknown"} <${data.user?.email ?? "no email"}>`;
  } catch (err) {
    return `lookup failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function useChatChannel() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [mode, setMode] = useState<ChatMode>("text");
  const [status, setStatus] = useState<ChatChannelState>("closed");
  const [accessKey, setAccessKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [energyBalance, setEnergyBalance] = useState<number | null>(null);
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [audioState, setAudioState] = useState<AudioPlayerState>("idle");
  const [audioTime, setAudioTime] = useState(0);
  // Exposed alongside the ref below so the widget can scope its audioTime-driven active/spoken
  // word highlighting to only the bubble currently being read — word timestamps restart near 0
  // for every message, so without this a past message's words satisfy the same "active" window
  // as the one actually playing and light back up during it.
  const [karaokeMessageId, setKaraokeMessageId] = useState<string | null>(null);
  // Reflects Iris.authorize() specifically — separate from currentUser above, which looks up
  // whatever bearer token was pasted into the token field via GET /v1/users/me instead.
  const [signedInUser, setSignedInUser] = useState<User | null>(Iris.getCurrentUser());
  const channelRef = useRef<ChatChannel | null>(null);
  const unsubsRef = useRef<Array<() => void>>([]);
  // The id of the message currently being "read" word-by-word — subtitle_chunk carries no "first
  // word of a new message" flag, so this is how a fresh message's words replace the previous
  // message's instead of appending onto it forever. Mirrored into karaokeMessageId (state) above;
  // this ref is what the event handler closures below actually read, since they need the current
  // value synchronously rather than a render's stale snapshot.
  const karaokeMessageIdRef = useRef<string | null>(null);

  const setKaraokeMessage = useCallback((id: string | null) => {
    karaokeMessageIdRef.current = id;
    setKaraokeMessageId(id);
  }, []);
  // Guards against overlapping connect() calls (e.g. React StrictMode's dev-mode double effect
  // invocation) racing each other — whichever call's async work resolves last would otherwise
  // silently win, leaving an earlier call's channel orphaned but still emitting into this hook's
  // shared setState calls.
  const connectionIdRef = useRef(0);

  const signIn = useCallback((credential: Credential) => Iris.authorize(credential), []);

  const connect = useCallback(async (personaId: string, token?: string, clientLanguage?: string, initialMode: ChatMode = "text", existingAccessKey?: string) => {
    const connectionId = ++connectionIdRef.current;

    unsubsRef.current.forEach((unsub) => unsub());
    unsubsRef.current = [];
    channelRef.current?.disconnect();
    channelRef.current = null;

    setMessages([]);
    setAccessKey(null);
    setError(null);
    setStatus("connecting");
    setMode(initialMode);
    setSuggestions([]);
    setEnergyBalance(null);
    setKaraokeMessage(null);
    setCurrentUser(null);
    setAudioState("idle");
    setAudioTime(0);

    if (token) void fetchCurrentUser(token).then((label) => connectionIdRef.current === connectionId && setCurrentUser(label));

    try {
      // A pasted access key skips createChatSession entirely and reconnects straight to that
      // existing chat session (e.g. one created in a previous page load).
      const accessKey = existingAccessKey || (await Iris.createChatSession(personaId, { token })).accessKey;
      if (connectionIdRef.current !== connectionId) return;

      setAccessKey(accessKey);

      const channel = Iris.connect(accessKey, {
        mode: initialMode,
        token,
        personaId,
        clientLanguage: clientLanguage || navigator.language
      });

      if (connectionIdRef.current !== connectionId) {
        channel.disconnect();
        return;
      }

      channelRef.current = channel;

      unsubsRef.current.push(
        channel.on("state_change", (e) => setStatus(e.state)),
        channel.on("user_message", (e) => {
          setMessages((prev) => [...prev, { id: e.id, role: "user", text: e.text }]);
        }),
        channel.on("persona_message_chunk", (e) => {
          setMessages((prev) => upsertPersonaMessage(prev, e.id, e.delta, false));
        }),
        channel.on("persona_message", (e) => {
          setMessages((prev) => upsertPersonaMessage(prev, e.id, e.content, true, e.mediaAttachments));
        }),
        channel.on("tool_use_start", (e) => {
          setMessages((prev) => [...prev, { id: `tool-${prev.length}`, role: "system", text: `🔧 ${e.tool}…` }]);
        }),
        channel.on("tool_use", (e) => {
          setMessages((prev) => [...prev, { id: `tool-${prev.length}`, role: "system", text: describeToolUse(e.payload) }]);
        }),
        channel.on("reply_suggestions", (e) => setSuggestions(e.suggestions)),
        channel.on("energy_balance", (e) => setEnergyBalance(e.balance)),
        channel.on("error", (e) => {
          console.error("chat error", e.error);
          setError(e.error.message ?? e.error.reason ?? "unknown error");
        }),
        channel.speech.on("subtitle_chunk", (e) => {
          const word: CaptionWord = { text: e.text, startMs: e.startMs, durationMs: e.durationMs };
          const isNewMessage = karaokeMessageIdRef.current !== e.id;
          setKaraokeMessage(e.id);

          setMessages((prev) => {
            const index = prev.findIndex((m) => m.id === e.id);

            if (index === -1) {
              return [...prev, { id: e.id, role: "persona", text: "", karaokeWords: [word] }];
            }

            const next = [...prev];
            const prevWords = isNewMessage ? [] : (next[index].karaokeWords ?? []);
            next[index] = { ...next[index], karaokeWords: [...prevWords, word] };

            return next;
          });
        }),
        channel.speech.player.on("state_change", setAudioState)
      );
    } catch (err) {
      if (connectionIdRef.current !== connectionId) return;

      setStatus("errored");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    return () => {
      unsubsRef.current.forEach((unsub) => unsub());
      channelRef.current?.disconnect();
      channelRef.current = null;
    };
  }, []);

  useEffect(() => Iris.onAuthChange(setSignedInUser), []);

  // AudioPlayer only emits state_change — currentTime ticks internally with no dedicated event,
  // so this is the same polling approach the vanilla example uses to surface it live. 80ms keeps
  // the karaoke word highlight (driven off this same audioTime) reasonably smooth.
  useEffect(() => {
    const interval = setInterval(() => {
      const player = channelRef.current?.speech.player;
      if (player) setAudioTime(player.currentTime);
    }, 80);

    return () => clearInterval(interval);
  }, []);

  const sendMessage = (text: string) => {
    if (!text.trim()) return;
    setSuggestions([]);
    // createIntent() interrupts any in-flight speech (player.stop(), resetting currentTime to 0)
    // before the message is sent — clear this too, or the just-interrupted bubble stays "current"
    // and its first word's startMs window matches the reset audioTime, lighting it back up.
    setKaraokeMessage(null);
    channelRef.current?.createIntent("reply", { text });
  };

  // Both open the conversation with no user-typed text — "initiation" has the persona lead with
  // whatever it'd naturally open with, "selfintroduction" specifically asks it to introduce itself.
  const sendInitiation = () => {
    channelRef.current?.createIntent("initiation", {});
  };

  const sendSelfIntroduction = () => {
    channelRef.current?.createIntent("selfintroduction", {});
  };

  // Continues an in-progress voice turn (e.g. after stopAudio() interrupts it), same payload
  // shape as "reply". Unlike "reply", the SDK doesn't synthesize a local user_message for it —
  // the wire never echoes it back — so the bubble is added here instead.
  const sendContinuation = (text: string) => {
    if (!text.trim()) return;
    setSuggestions([]);
    setKaraokeMessage(null);
    setMessages((prev) => [...prev, { id: `continuation-${prev.length}`, role: "user", text, isContinuation: true }]);
    channelRef.current?.createIntent("continuation", { text });
  };

  const toggleVoice = () => {
    if (!channelRef.current) return;

    const next: ChatMode = mode === "text" ? "audio_text" : "text";
    channelRef.current.setMode(next);
    setMode(next);

    // Leaves whatever's already rendered in the bubble alone — only stops routing further
    // updates into it, so the last-spoken words stay visible instead of vanishing.
    if (next === "text") setKaraokeMessage(null);
  };

  const stopAudio = () => {
    channelRef.current?.speech.player.stop();
    setKaraokeMessage(null);
  };

  // Iris.getChatHistory() only returns one page (most recent N messages, oldest first) — see its
  // doc comment in the SDK for why there's no further pagination today. Replaces the message list
  // outright rather than merging, since this is meant for restoring a session, not live chat.
  const loadHistory = async () => {
    if (!accessKey) return;

    setKaraokeMessage(null);

    try {
      const history = await Iris.getChatHistory(accessKey);
      setMessages(history.map((m) => ({ id: m.id, role: m.role, text: m.text, mediaAttachments: m.mediaAttachments })));
    } catch (err) {
      setMessages([
        { id: "history-error", role: "system", text: `failed to load history: ${err instanceof Error ? err.message : String(err)}` }
      ]);
    }
  };

  return {
    messages,
    mode,
    status,
    accessKey,
    error,
    suggestions,
    energyBalance,
    currentUser,
    signedInUser,
    signIn,
    audioState,
    audioTime,
    karaokeMessageId,
    connect,
    sendMessage,
    sendInitiation,
    sendSelfIntroduction,
    sendContinuation,
    loadHistory,
    toggleVoice,
    stopAudio
  };
}
