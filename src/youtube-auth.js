// One-time YouTube authorization.
//
//   npm run yt:auth
//
// Opens a Google consent page, captures the redirect on localhost, and saves a
// refresh token to .youtube-token.json so the uploader can run unattended.
// Run this once (re-run only if you revoke access or change scopes).

import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { loadEnv } from "./env.js";
import { makeOAuthClient, SCOPES, TOKEN_PATH, PORT, REDIRECT_URI } from "./youtube-oauth.js";

loadEnv();

const oauth = makeOAuthClient();
const authUrl = oauth.generateAuthUrl({
  access_type: "offline",      // get a refresh token
  prompt: "consent",           // force refresh_token even on re-auth
  scope: SCOPES,
});

const server = createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) {
    res.writeHead(404).end();
    return;
  }
  const code = new URL(req.url, REDIRECT_URI).searchParams.get("code");
  const err = new URL(req.url, REDIRECT_URI).searchParams.get("error");

  if (err || !code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h2>Authorization failed: ${err || "no code"}</h2>`);
    console.error("\n✗ Authorization failed:", err || "no code returned");
    server.close();
    process.exit(1);
  }

  try {
    const { tokens } = await oauth.getToken(code);
    writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>✓ Authorized. You can close this tab and return to the terminal.</h2>");
    console.log(`\n✓ Token saved → ${TOKEN_PATH}`);
    if (!tokens.refresh_token) {
      console.warn("⚠ No refresh_token returned. Revoke access at " +
        "https://myaccount.google.com/permissions and run `npm run yt:auth` again.");
    }
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500).end("Token exchange failed.");
    console.error("\n✗ Token exchange failed:", e.message);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT_URI}`);
  console.log("\nOpen this URL to authorize (also attempting to open it for you):\n");
  console.log(authUrl + "\n");
  exec(`open "${authUrl}"`, () => {}); // macOS; harmless if it fails
});
