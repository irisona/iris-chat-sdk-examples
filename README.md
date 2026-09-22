# iris-chat-sdk-examples

Standalone example apps demonstrating `@irisona/chat-sdk`.

## Examples

- [`react/`](react/) — React chat widget using `@irisona/chat-sdk`.

## Setup

`@irisona/chat-sdk` is published to GitHub Packages under the `irisona` org (restricted, not public npm). Before running any example:

1. Create a GitHub personal access token with `read:packages` scope (Settings → Developer settings → Personal access tokens → Tokens (classic)).
2. In the example's folder, copy `.npmrc.example` to `.npmrc` and fill in your token:
   ```bash
   cd react
   cp .npmrc.example .npmrc
   # edit .npmrc, replace YOUR_GITHUB_TOKEN_WITH_read:packages_SCOPE with your token
   ```
3. Install and run:
   ```bash
   npm install
   npm run dev
   ```

`.npmrc` is gitignored — never commit it.
