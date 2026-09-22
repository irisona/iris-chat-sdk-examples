# @irisona/chat-sdk API Reference


## Contents

- [Quick start](#quick-start)
- [`Iris` namespace](#iris-namespace)
- [`ChatChannel`](#chatchannel)
- [`SpeechChannel`](#speechchannel)
- [`AudioPlayer`](#audioplayer)
- [Token storage](#token-storage)
- [Types](#types)
- [Error handling](#error-handling)

## Quick start

```ts
import { Iris } from "@irisona/chat-sdk";

// Optional: sign in first so the chat session is tied to a real user instead of a guest.
// createChatSession()/connect() below pick up the stored token automatically — no need to
// pass it again yourself.
await Iris.authorize({ provider: "geoguessr", idToken });

// Omit this call entirely (and opts.token below) for a guest session.
const session = await Iris.createChatSession("persona_id");
const channel = Iris.connect(session.accessKey, { mode: "text", clientLanguage: navigator.language });

channel.on("persona_message_chunk", (e) => appendToBubble(e.id, e.delta));
await channel.createIntent("reply", { text: "hey!" });

// Resuming a session? Load what was already said, oldest first.
const history = await Iris.getChatHistory(session.accessKey);
```

## `Iris` namespace

Everything the SDK exposes hangs off this one object.

### `Iris.createChatSession(personaId, opts?)`

```ts
function createChatSession(personaId: string, opts?: { token?: string }): Promise<ChatSession>;
```

Opens a new chat session against a persona. Pass
`opts.token` (a bearer token from `Iris.authorize()` or your own auth flow) for a signed-in
session, or omit it for a guest session — the backend issues one from the anonymous request.
Resolves to `{ accessKey }`, the capability string that authorizes `Iris.connect()` and
`Iris.getChatHistory()`.

Unlike the main app, this **never** falls back to a bundled guest credential — this package ships
to third-party sites, so no such secret exists here. No token means no `Authorization` header at
all.

### `Iris.connect(accessKey, opts)`

```ts
function connect(accessKey: string, opts: ConnectOptions): ChatChannel;

interface ConnectOptions {
  mode?: ChatMode; // "text" | "audio_text", default "text"
  token?: string;
  clientLanguage?: string;
  personaId: string;
}
```

Opens (synchronously returns) a [`ChatChannel`](#chatchannel) joined to `session:{accessKey}` over
Phoenix. The `accessKey` embedded in the topic is itself the capability that authorizes the
channel — no bearer token is sent in the join payload. `opts.token` (falling back to whatever
`Iris.authorize()` last stored) is only used for the socket's own connect params and for the
speech subsystem's provider-token lookups.

`opts.personaId` is required even for `mode: "text"` — a channel constructed as text-only can
still be switched into voice with `channel.setMode("audio_text")` later, and by then it's too late
to ask for a personaId. See [why voice needs it](#speechchannel) below.

### `Iris.getChatHistory(accessKey, opts?)`

```ts
function getChatHistory(accessKey: string, opts?: { limit?: number; token?: string }): Promise<HistoryMessage[]>;
```

Fetches one page of the most recent `opts.limit` (default 50) messages, returned **oldest first**
(the wire itself is newest-first; the SDK reverses it for you). Only plain chat turns come back —
tool-use synthetic entries are skipped.

> ⚠️ There is currently no working pagination past that one page — the backend's filter is a
> lower bound only (messages at-or-after some point in time), with no upper-bound equivalent, and
> the response never carries a pagination cursor of its own.

#### Planned: `opts.from` / `opts.before`

**Not implemented yet** — `src/session.ts` doesn't accept either option today. Documented here as
the intended contract for a future change, based on what the backend actually supports:

```ts
opts?: {
  limit?: number;
  token?: string;
  from?: string;   // ISO8601 timestamp, inclusive lower bound — sent to the backend as-is
  before?: string;  // ISO8601 timestamp, exclusive upper bound — enforced client-side only
};
```

- **`from`** maps directly to a real backend filter: "messages at or after this point in time."
  The backend has no equivalent upper-bound filter, so this is the only side a request can
  actually narrow.
- **`before`** can't be sent to the backend at all — there's nothing there to receive it. To honor
  it, the SDK would have to omit `limit` (which makes the backend return the *entire* session
  history in one response), then filter that full set down to `[from, before)` and apply `limit`
  client-side, keeping the most recent messages within that window. That means passing `before`
  turns a normal one-page request into a full-history fetch under the hood — worth knowing before
  reaching for it on a long-running conversation.

### `Iris.getPersona(personaId, opts?)`

```ts
function getPersona(personaId: string, opts?: { token?: string }): Promise<Persona>;
```

Fetches a persona's own public profile info (`GET /v1/personas/:id`) — the same endpoint
`SpeechChannel` already calls internally to resolve voice config. `opts.token` falls back to
whatever `Iris.authorize()` last stored, same as elsewhere; personas that aren't public require a
signed-in token with access to them. Rejects on a non-OK HTTP response.

Only exposes a lean, public-facing subset of what the backend returns — this package ships to
third-party sites, so admin-only fields (`monetization`, `user_id`, `xp`, `draft`, invitation
codes, etc.) are deliberately left out.

### `Iris.authorize(credential)`

```ts
function authorize(credential: Credential): Promise<{ user: User }>;

type Credential = { provider: string; [key: string]: unknown };
```

Signs in and stores the resulting session (token, refresh token, expiry, user) via the configured
[storage adapter](#token-storage). `provider` identifies a partner site's own auth — e.g.
`"geoguessr"` — and the credential is forwarded **as-is**, matching whatever fields that partner
integration's backend contract expects, in wire (snake_case) form.

Once authorized, the SDK schedules its own silent refresh ~30s before `expiresAt`, and retries a
refresh exactly once if `ChatChannel` sees a `401`/`"unauthorized"` join error or an unexpected
socket close.

### `Iris.getCurrentUser()`

```ts
function getCurrentUser(): User | null;
```

Returns the user from the last successful `Iris.authorize()` call (rehydrated from storage on
`configure()`, if that adapter had a live, non-expired session). `null` for guests, and `null` if
you never call `Iris.authorize()` — this does **not** reflect an externally-obtained bearer token
passed straight into `createChatSession`/`connect`.

### `Iris.onAuthChange(cb)`

```ts
function onAuthChange(cb: (user: User | null) => void): Unsubscribe;
```

Fires on every sign-in, sign-out, and successful silent refresh. Call the returned function to
unsubscribe.

### `Iris.configure(opts)`

```ts
function configure(opts: { storage?: TokenStorageAdapter }): void;
```

Swaps the token storage adapter (see [Token storage](#token-storage)) and immediately attempts to
rehydrate a session from it. Call this once, before `Iris.authorize()`, if you want sessions to
survive a page reload.

## `ChatChannel`

Returned by `Iris.connect()`. Wraps one Phoenix channel (`session:{accessKey}`) plus a
[`SpeechChannel`](#speechchannel) for voice playback.

```ts
class ChatChannel {
  state: ChatChannelState; // "connecting" | "joined" | "errored" | "closed"
  mode: ChatMode; // "text" | "audio_text"
  speech: SpeechChannel; // always present; only its socket is lazy

  on<K extends ChatEventType>(event: K, cb: (e: Extract<ChatEvent, { type: K }>) => void): Unsubscribe;
  off<K extends ChatEventType>(event: K, cb: (e: Extract<ChatEvent, { type: K }>) => void): void;
  once<K extends ChatEventType>(event: K, cb: (e: Extract<ChatEvent, { type: K }>) => void): Unsubscribe;

  setMode(mode: ChatMode): void;
  createIntent(type: IntentType, payload: unknown): Promise<IntentResult>;
  disconnect(): void;
}
```

### `channel.on(event, cb)` / `off` / `once`

Typed pub/sub over [`ChatEvent`](#chatevent). `cb`'s parameter type narrows automatically to the
event you subscribed to.

### `channel.setMode(mode)`

Switches between `"text"` and `"audio_text"`. Lazily opens or tears down the speech socket —
`channel.speech` itself is always the same object, so listeners attached once (e.g. on
`channel.speech.player`) keep working across mode toggles. A no-op if `mode` is unchanged.

### `channel.createIntent(type, payload)`

```ts
type IntentType = "reply" | "continuation" | "initiation" | "extra_context" | "selfintroduction";

interface IntentResult {
  id: string;
  status: "sent" | "failed";
  error?: ChatError;
}
```

Sends a `new_message` push and resolves once the backend acks it (`"sent"`) or rejects it
(`"failed"`, with `error`). This resolves on **delivery**, not on the persona's reply — listen for
`persona_message`/`persona_message_chunk` events for that.

| `type` | Payload | Use |
|---|---|---|
| `"reply"` | `{ text: string }` or a plain `string` | Normal user turn. Emits a synthesized `user_message` event locally (the wire never echoes it back). In `"audio_text"` mode, this also stops any in-flight speech playback — a new send always interrupts, mirroring the app's barge-in behavior, so most consumers never call `player.stop()` themselves. |
| `"continuation"` | same as `"reply"` | Continues an in-progress voice turn; wire-encoded specially (`context` instead of `content`) — ported verbatim from the main app. |
| `"initiation"` | `{}` | Opens the conversation with no user input — the persona speaks first, whatever it'd naturally open with. |
| `"selfintroduction"` | `{}` | Asks the persona to introduce itself specifically. |
| `"extra_context"` | `{ text: string }` | Same shape as `"reply"`, different wire intent type. |

Multiple `createIntent()` calls are matched to their `intent:created` acks strictly FIFO — don't
rely on out-of-order resolution.

### `channel.disconnect()`

Leaves the Phoenix channel, disconnects the socket, disconnects `channel.speech` (which also stops
any playing audio), and transitions `state` to `"closed"`. Always call this on teardown (page
unload, component unmount, switching personas) — see both example apps for the pattern.

## `SpeechChannel`

`channel.speech` — a separate WebSocket connection for TTS playback, kept distinct from the chat
channel so a TTS failure never gets conflated with a chat-channel failure. Speaks either
ElevenLabs' JSON protocol or Fish Audio's msgpack-framed one, chosen per-persona from
`persona.voice.provider_name`.

```ts
class SpeechChannel {
  state: SpeechState; // "connecting" | "connected" | "errored" | "closed"
  player: AudioPlayer;

  on<K extends SpeechEventType>(event: K, cb: (e: Extract<SpeechEvent, { type: K }>) => void): Unsubscribe;
  disconnect(): void;
}
```

You normally don't call anything else on it directly — `ChatChannel.setMode("audio_text")` drives
`activate()`/`deactivate()`, and streaming persona text is routed into it automatically. Just
subscribe to its events and to `channel.speech.player`.

### `speech.on(event, cb)`

```ts
type SpeechEvent =
  | { type: "subtitle_chunk"; id: string; text: string; startMs: number; durationMs: number }
  | { type: "audio_chunk"; id: string; pcm: ArrayBuffer }
  | { type: "error"; error: ChatError }
  | { type: "state_change"; state: SpeechState };
```

- **`subtitle_chunk`** — one word at a time, with its timing relative to that message's own
  playback start (`AudioPlayer.currentTime` resets the same way, per message id). Use this to
  drive karaoke-style captions — see `addSpokenWord`/`updateCaptionHighlight` in
  `examples/vanilla/main.ts` for a full implementation, including the "no space if the provider
  split one word across two segments" edge case.
- **`audio_chunk`** — raw PCM (16kHz, mono) for the current message. You don't need to do anything
  with this yourself; it's already been handed to `player.enqueue()`. Useful only if you want to
  do your own visualization/recording.
- **`error`** — socket failed to open, or a frame failed to decode.
- **`state_change`** — mirrors `speech.state`.

## `AudioPlayer`

`channel.speech.player` — gapless PCM playback via Web Audio. Ported from the main app's
`useSpeechOutCore`.

```ts
class AudioPlayer {
  state: AudioPlayerState; // "idle" | "playing"
  currentMessageId: string | null;
  currentTime: number; // ms elapsed in the current message's playback, polled ~60fps internally

  on(event: "state_change", cb: (state: AudioPlayerState) => void): Unsubscribe;
  stop(): void;
}
```

- **`currentTime`** has no dedicated change event — poll it (both examples use a `setInterval`,
  16–80ms) if you're driving a UI off it, e.g. caption highlighting.
- **`stop()`** is a hard interrupt: drops everything queued/scheduled and silences immediately by
  swapping the internal `GainNode` rather than stopping every buffer source by hand. `reply`
  intents in `"audio_text"` mode call this for you already (barge-in); call it yourself for an
  explicit "stop speaking" control.

## Token storage

```ts
interface TokenStorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}
```

The default adapter is in-memory — nothing survives a page reload unless you opt in:

```ts
import { Iris, localStorageAdapter } from "@irisona/chat-sdk";

Iris.configure({ storage: localStorageAdapter });
```

Bring your own adapter (e.g. wrapping `AsyncStorage` on React Native) by implementing the three
methods above.

## Types

All exported from the package root.

| Type | Shape |
|---|---|
| `ChatSession` | `{ accessKey: string }` |
| `Persona` | `{ id, name, avatar?, defaultLanguage, disabledFeatures, voiceStyle?, selfIntroduction?, currentMode? }` |
| `PersonaMode` | `{ id, name, description }` |
| `User` | `{ id: string; [key: string]: unknown }` |
| `HistoryMessage` | `{ id, role: "user" \| "persona", text, mediaAttachments?, insertedAt }` |
| `MediaAttachment` | `{ mediaId, name, mediaUrl? }` |
| `ChatError` | `{ category?, message?, reason?, [key: string]: unknown }` |
| `ChatMode` | `"text" \| "audio_text"` |
| `ChatChannelState` | `"connecting" \| "joined" \| "errored" \| "closed"` |
| `SpeechState` | `"connecting" \| "connected" \| "errored" \| "closed"` |
| `AudioPlayerState` | `"idle" \| "playing"` |
| `Unsubscribe` | `() => void` |

### `ChatEvent`

```ts
type ChatEvent =
  | { type: "user_message"; id: string; text: string }
  | { type: "persona_message_chunk"; id: string; delta: string }
  | { type: "persona_message"; id: string; content: string; mediaAttachments?: MediaAttachment[] }
  | { type: "tool_use_start"; tool: string }
  | { type: "tool_use"; payload: ToolUsePayload }
  | { type: "reply_suggestions"; suggestions: string[] }
  | { type: "task_update"; id: string; status: string }
  | { type: "energy_balance"; balance: number }
  | { type: "error"; error: ChatError }
  | { type: "state_change"; state: ChatChannelState };
```

- **`user_message`** is synthesized locally by `createIntent("reply", …)` — the wire never echoes
  the caller's own message back.
- **`persona_message_chunk`** fires per streaming delta; the first chunk of a turn assigns the
  `id` that all of that turn's events (including the final `persona_message`) share.
- **`persona_message`** is the final, complete text for a turn (may carry `mediaAttachments` with
  empty `content` when the turn is media-only).
- **`tool_use_start`** / **`tool_use`** bracket a persona action (image/video/voice generation,
  avatar changes, persona creation, etc.) — see `ToolUsePayload` below for the typed cases and
  their extra fields.
- **`reply_suggestions`** — quick-reply chips the persona/backend suggests.
- **`energy_balance`** — the user's remaining energy/credits after this turn.

### `ToolUsePayload`

```ts
type ToolUsePayload =
  | { name: "image_generation"; mediaUrl?: string }
  | { name: "video_generation"; id?: string; status?: string; mediaUrl?: string }
  | { name: "voice_generation"; voices?: unknown[] }
  | { name: string; [key: string]: unknown }; // any other tool name, raw fields passed through
```

This is the SDK's own typed source of truth for tool-use payloads — there was no formal union
server-side to port from. The three shown above are the common cases; the fallback arm covers
every other `name` the backend can send (avatar changes, persona creation/drafting, signup,
energy package selection, and more) — treat those as forward-compatible and read whatever fields
you need off them.

## Error handling

- **`ChatChannel`**: subscribe to the `"error"` event. Join failures (bad/expired accessKey,
  timeout) and mid-session `phx_error`/`error` frames all surface here with a `ChatError`. A join
  error whose `category` contains `"unauthorized"` triggers one automatic refresh-and-retry via
  the token store — you don't need to handle that case specially.
- **`SpeechChannel`**: separately, subscribe to `speech.on("error", …)`. A speech-socket failure
  (e.g. the persona has no active voice configured, or the socket itself errors) never surfaces on
  the chat channel's `"error"` event.
- **`createIntent()`**: also reports failures inline via its resolved `IntentResult.status` —
  check `status === "failed"` in addition to (or instead of) listening for `"error"`.
- **Promise rejections**: `Iris.createChatSession`, `Iris.getChatHistory`, and `Iris.authorize`
  reject (rather than emitting an event) on a non-OK HTTP response — wrap those calls in
  `try/catch`.
