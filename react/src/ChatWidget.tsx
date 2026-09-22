import { Iris } from "@irisona/chat-sdk";
import { useState } from "react";
import { USER_DETAIL_URL, useChatChannel } from "./useChatChannel";

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
    audioState,
    audioTime,
    karaokeMessageId,
    connect,
    sendMessage,
    sendInitiation,
    sendSelfIntroduction,
    loadHistory,
    toggleVoice,
    stopAudio
  } = useChatChannel();
  const [input, setInput] = useState("");
  const [personaId, setPersonaId] = useState(defaultPersonaId);
  const [token, setToken] = useState("");
  const [language, setLanguage] = useState("");
  const [userObject, setUserObject] = useState("");

  const handleSend = (text: string) => {
    setInput("");
    sendMessage(text);
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

  const debugLines = [
    `personaId: ${personaId}`,
    `accessKey: ${accessKey ?? "-"}`,
    `auth: ${token.trim() ? "bearer token" : "guest"}`,
    currentUser ? `currentUser: ${currentUser}` : null,
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
        <label>
          Bearer token (optional — omit for a guest session)
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="paste an auth token…" />
        </label>
        <button type="button" onClick={() => void handleGetCurrentUser()}>
          Get current user
        </button>
        {userObject && <pre className="chat-widget__debug">{userObject}</pre>}
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
        <button onClick={() => void connect(personaId, token.trim() || undefined, language || undefined)}>Connect</button>
      </fieldset>

      <pre className="chat-widget__debug">{debugLines.join("\n")}</pre>

      <div className="chat-widget__status">{status}</div>

      <div className="chat-widget__messages">
        {messages.map((m) => (
          <div key={m.id} className={`bubble bubble--${m.role}`}>
            {m.karaokeWords ? (
              m.karaokeWords.map((w, i) => {
                // Word timestamps restart near 0 for every message, so audioTime alone can't
                // tell this bubble's words apart from a past message's — only the bubble that's
                // actually playing gets to compare against it; any other just reads as spoken.
                const isCurrent = karaokeMessageId === m.id;
                const isActive = isCurrent && audioTime >= w.startMs && audioTime < w.startMs + w.durationMs;
                const isSpoken = !isCurrent || audioTime >= w.startMs + w.durationMs;

                return (
                  <span
                    key={i}
                    className={`caption-word${isActive ? " caption-word--active" : isSpoken ? " caption-word--spoken" : ""}`}
                  >
                    {w.text}
                  </span>
                );
              })
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
        <button onClick={() => handleSend(input)}>Send</button>
        <button onClick={toggleVoice}>{mode === "audio_text" ? "🔊" : "🔇"}</button>
        <button onClick={stopAudio}>⏹</button>
      </div>
    </div>
  );
}
