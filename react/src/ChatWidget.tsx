import { Iris, type ChatMode } from "@irisona/chat-sdk";
import { useState } from "react";
import { type CaptionWord, USER_DETAIL_URL, useChatChannel } from "./useChatChannel";

type TextSegment = { text: string; className?: string };

// How far past the cursor a karaoke word is allowed to match. Without a cap, a word that doesn't
// match right where expected (TTS split a contraction, normalized a number, dropped punctuation,
// …) falls through to indexOf's *next* occurrence of that text — which for a common short word
// ("the", "a", "I") can be sentences away, snapping the highlight far ahead and compounding on
// every word after it. Bounding the search to a plausible next-word distance means a mismatch is
// just skipped (no highlight for that word) instead of teleporting.
const MAX_WORD_LOOKAHEAD = 40;

// Splits a persona bubble's full text into plain runs plus per-word spans wherever a karaoke
// word (from subtitle_chunk) can be located in it, so the whole message is visible immediately
// while the word currently being spoken still lights up inline. Matches words in order via a
// forward-only cursor — a word whose text can't be found within MAX_WORD_LOOKAHEAD of the cursor
// is just left unhighlighted rather than matching some unrelated later occurrence.
function buildTextSegments(text: string, words: CaptionWord[], isCurrent: boolean, audioTime: number): TextSegment[] {
  if (words.length === 0) return [{ text }];

  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const w of words) {
    const idx = text.indexOf(w.text, cursor);
    if (idx === -1 || idx - cursor > MAX_WORD_LOOKAHEAD) continue;

    if (idx > cursor) segments.push({ text: text.slice(cursor, idx) });

    const isActive = isCurrent && audioTime >= w.startMs && audioTime < w.startMs + w.durationMs;
    const isSpoken = !isCurrent || audioTime >= w.startMs + w.durationMs;
    segments.push({
      text: w.text,
      className: `caption-word${isActive ? " caption-word--active" : isSpoken ? " caption-word--spoken" : ""}`
    });

    cursor = idx + w.text.length;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor) });

  return segments;
}

export function ChatWidget({ defaultPersonaId }: { defaultPersonaId: string }) {
  const {
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
  } = useChatChannel();
  const [input, setInput] = useState("");
  const [personaId, setPersonaId] = useState(defaultPersonaId);
  const [accessKeyInput, setAccessKeyInput] = useState("");
  const [token, setToken] = useState("");
  const [language, setLanguage] = useState("");
  const [initialMode, setInitialMode] = useState<ChatMode>("text");
  const [userObject, setUserObject] = useState("");
  const [personaObject, setPersonaObject] = useState("");
  const [authProvider, setAuthProvider] = useState("");
  const [authIdToken, setAuthIdToken] = useState("");
  const [authStatus, setAuthStatus] = useState("");

  // Iris.authorize() is the alternative to pasting a bearer token above: sign in with a partner
  // credential and createChatSession()/connect() below pick up the stored token automatically —
  // leave the token field blank once signed in.
  const handleSignIn = async () => {
    const provider = authProvider.trim();
    if (!provider) {
      setAuthStatus("provider is required");
      return;
    }

    setAuthStatus("signing in…");

    try {
      // Credential's catch-all branch (any provider other than "apple"/"google") is forwarded to
      // /sessions/authorize as-is, so the field must already be "id_token" — camelCase idToken
      // only gets converted for the SDK's own built-in "apple"/"google" providers.
      const { user } = await signIn({ provider, id_token: authIdToken.trim() });
      setAuthStatus(`signed in as ${JSON.stringify(user)}`);
    } catch (err) {
      setAuthStatus(`sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSend = (text: string) => {
    setInput("");
    sendMessage(text);
  };

  const handleContinuation = (text: string) => {
    setInput("");
    sendContinuation(text);
  };

  // Iris.getCurrentUser() only reflects Iris.authorize() — this example never calls it (its
  // backend endpoint, POST /v1/auth/sessions, doesn't exist yet), so that call alone would just
  // show null. With a pasted token, fetch the real object from GET /v1/users/me instead.
  const handleGetCurrentUser = async () => {
    const trimmedToken = token.trim();

    if (!trimmedToken) {
      setUserObject(
        `Iris.getCurrentUser() -> ${JSON.stringify(Iris.getCurrentUser())}\n\n` +
        "null because it only reflects Iris.authorize(), and that flow's backend endpoint " +
        "(POST /v1/auth/sessions) doesn't exist yet on api.irisona.net — paste a bearer token " +
        "above to fetch the real user object instead."
      );
      return;
    }

    setUserObject("loading…");

    try {
      const res = await fetch(USER_DETAIL_URL, { headers: { Authorization: `Bearer ${trimmedToken}` } });
      const data = await res.json();
      setUserObject(res.ok ? JSON.stringify(data, null, 2) : `GET /v1/users/me failed: ${res.status}\n${JSON.stringify(data, null, 2)}`);
    } catch (err) {
      setUserObject(`lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Iris.getPersona() is a plain lookup (GET /v1/personas/:id) — no channel connection needed, so
  // it can run against whatever's in the Persona ID field even before hitting Connect.
  const handleGetPersona = async () => {
    const trimmedPersonaId = personaId.trim();

    if (!trimmedPersonaId) {
      setPersonaObject("persona ID is required");
      return;
    }

    setPersonaObject("loading…");

    try {
      const persona = await Iris.getPersona(trimmedPersonaId, { token: token.trim() || undefined });
      setPersonaObject(JSON.stringify(persona, null, 2));
    } catch (err) {
      setPersonaObject(`Iris.getPersona failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const debugLines = [
    `personaId: ${personaId}`,
    `accessKey: ${accessKey ?? "-"}`,
    `auth: ${token.trim() ? "bearer token" : signedInUser ? "signed in (Iris.authorize)" : "guest"}`,
    currentUser ? `currentUser: ${currentUser}` : null,
    signedInUser ? `signedInUser (Iris.authorize): ${JSON.stringify(signedInUser)}` : null,
    `language: ${language || `${navigator.language} (browser default)`}`,
    `mode: ${mode}`,
    `state: ${status}`,
    energyBalance !== null ? `energy: ${energyBalance}` : null,
    mode === "audio_text" ? `audio: ${audioState} (${Math.round(audioTime)}ms)` : null,
    error ? `error: ${error}` : null
  ].filter(Boolean);

  return (
    <div className="chat-widget">
      <fieldset className="chat-widget__setup">
        <legend>Setup</legend>
        <label>
          Persona ID
          <input value={personaId} onChange={(e) => setPersonaId(e.target.value)} />
        </label>
        <button type="button" onClick={() => void handleGetPersona()}>
          Get persona
        </button>
        {personaObject && <pre className="chat-widget__debug">{personaObject}</pre>}
        <label>
          Access key (optional — reconnect to an existing chat session instead of creating one)
          <input
            value={accessKeyInput}
            onChange={(e) => setAccessKeyInput(e.target.value)}
            placeholder="paste an existing session's access key…"
          />
        </label>
        <label>
          Bearer token (optional — omit for a guest session)
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="paste an auth token…" />
        </label>
        <button type="button" onClick={() => void handleGetCurrentUser()}>
          Get current user
        </button>
        {userObject && <pre className="chat-widget__debug">{userObject}</pre>}
        <label>
          Auth provider (Iris.authorize — alternative to pasting a token above)
          <input value={authProvider} onChange={(e) => setAuthProvider(e.target.value)} placeholder="e.g. geoguessr" />
        </label>
        <label>
          Provider ID token
          <input value={authIdToken} onChange={(e) => setAuthIdToken(e.target.value)} placeholder="paste the provider's idToken…" />
        </label>
        <button type="button" onClick={() => void handleSignIn()}>
          Sign in
        </button>
        {authStatus && <pre className="chat-widget__debug">{authStatus}</pre>}
        <label>
          Client language (drives STT + reply language)
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="">Browser default</option>
            <option value="en">English</option>
            <option value="es">Spanish</option>
            <option value="fr">French</option>
            <option value="de">German</option>
            <option value="it">Italian</option>
            <option value="pt">Portuguese</option>
            <option value="vi">Vietnamese</option>
            <option value="ja">Japanese</option>
            <option value="ko">Korean</option>
            <option value="zh">Chinese</option>
            <option value="hi">Hindi</option>
            <option value="ar">Arabic</option>
          </select>
        </label>
        <label>
          Initial mode
          <select value={initialMode} onChange={(e) => setInitialMode(e.target.value as ChatMode)}>
            <option value="text">Text</option>
            <option value="audio_text">Audio + text</option>
          </select>
        </label>
        <button
          onClick={() =>
            void connect(personaId, token.trim() || undefined, language || undefined, initialMode, accessKeyInput.trim() || undefined)
          }
        >
          Connect
        </button>
      </fieldset>

      <pre className="chat-widget__debug">{debugLines.join("\n")}</pre>

      <div className="chat-widget__status">{status}</div>

      <div className="chat-widget__messages">
        {messages.map((m) => (
          <div key={m.id} className={`bubble bubble--${m.role}${m.isContinuation ? " bubble--continuation" : ""}`}>
            {m.karaokeWords ? (
              // Word timestamps restart near 0 for every message, so audioTime alone can't tell
              // this bubble's words apart from a past message's — only the bubble that's
              // actually playing gets to compare against it; any other just reads as spoken.
              buildTextSegments(m.text, m.karaokeWords, karaokeMessageId === m.id, audioTime).map((seg, i) =>
                seg.className ? (
                  <span key={i} className={seg.className}>
                    {seg.text}
                  </span>
                ) : (
                  seg.text
                )
              )
            ) : (
              m.text
            )}
            {m.mediaAttachments?.map((a) =>
              a.mediaUrl ? (
                /\.(mp4|webm|mov)$/i.test(a.mediaUrl) ? (
                  <video key={a.mediaId} src={a.mediaUrl} controls />
                ) : (
                  <img key={a.mediaId} src={a.mediaUrl} alt={a.name} />
                )
              ) : null
            )}
          </div>
        ))}
      </div>

      <div className="chat-widget__starters">
        <button onClick={sendInitiation}>Send initiation</button>
        <button onClick={sendSelfIntroduction}>Self-introduction</button>
        <button onClick={() => void loadHistory()}>Load history</button>
      </div>

      {suggestions.length > 0 && (
        <div className="chat-widget__suggestions">
          {suggestions.map((s) => (
            <button key={s} onClick={() => handleSend(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="chat-widget__composer">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend(input)}
          placeholder="Say hi…"
        />
        <button onClick={() => handleSend(input)}>Send text</button>
        <button onClick={() => handleContinuation(input)}>Send continuation</button>
        <button onClick={toggleVoice}>{mode === "audio_text" ? "🔊" : "🔇"}</button>
        <button onClick={stopAudio}>⏹</button>
      </div>
    </div>
  );
}
