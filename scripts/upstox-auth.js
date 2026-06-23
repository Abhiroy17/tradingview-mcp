#!/usr/bin/env node
/**
 * Upstox OAuth2 helper.
 *
 * Usage:
 *   1. In Upstox developer console, create an app with redirect URI
 *      `http://localhost:3000/upstox/callback` (or change AUTH_REDIRECT below)
 *   2. Add UPSTOX_API_KEY + UPSTOX_API_SECRET to .env
 *   3. Run `npm run upstox:auth`
 *   4. Browser opens to Upstox login → consent → callback hits this script
 *   5. Access token written to .data/upstox-token.json
 *
 * Tokens expire daily — re-run this script each morning, or pin it to cron.
 */

import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import UpstoxClient from 'upstox-js-sdk';

const AUTH_PORT = 3000;
const AUTH_REDIRECT = `http://localhost:${AUTH_PORT}/upstox/callback`;
const TOKEN_FILE = path.resolve(process.cwd(), '.data', 'upstox-token.json');

const apiKey = process.env.UPSTOX_API_KEY;
const apiSecret = process.env.UPSTOX_API_SECRET;

if (!apiKey || !apiSecret) {
  console.error('ERROR: UPSTOX_API_KEY and UPSTOX_API_SECRET must be set in .env');
  process.exit(1);
}

const authUrl =
  'https://api.upstox.com/v2/login/authorization/dialog' +
  `?client_id=${encodeURIComponent(apiKey)}` +
  `&redirect_uri=${encodeURIComponent(AUTH_REDIRECT)}` +
  `&response_type=code` +
  `&state=${Date.now()}`;

console.log('\nOpen this URL in your browser if it does not open automatically:\n');
console.log(authUrl);
console.log('\nWaiting for callback on', AUTH_REDIRECT, '...\n');

// Auto-open browser (Windows)
exec(`start "" "${authUrl}"`, () => { /* best-effort */ });

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/upstox/callback')) {
    res.writeHead(404).end('Not found');
    return;
  }
  const url = new URL(req.url, `http://localhost:${AUTH_PORT}`);
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('Missing ?code=');
    return;
  }

  try {
    const loginApi = new UpstoxClient.LoginApi();
    const token = await new Promise((resolve, reject) => {
      loginApi.token(
        '2.0',                  // apiVersion
        code,
        apiKey,
        apiSecret,
        AUTH_REDIRECT,
        'authorization_code',
        (err, data) => err ? reject(err) : resolve(data),
      );
    });

    await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
    await fs.writeFile(
      TOKEN_FILE,
      JSON.stringify({
        accessToken: token.access_token,
        userId: token.user_id,
        userName: token.user_name,
        broker: token.broker,
        exchanges: token.exchanges,
        savedAt: new Date().toISOString(),
      }, null, 2),
    );

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h1>OK</h1><p>Access token saved to ${TOKEN_FILE}. You can close this tab.</p>`);
    console.log('Access token saved to', TOKEN_FILE);
    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    console.error('Token exchange failed:', err);
    res.writeHead(500).end(`<pre>${err.message}</pre>`);
    setTimeout(() => process.exit(1), 500);
  }
});

server.listen(AUTH_PORT);
