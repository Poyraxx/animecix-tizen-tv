import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const directory = join(process.env.LOCALAPPDATA, 'AnimeciXTV');
const key = readFileSync(join(directory, 'bridge-key.bin'));
const configPath = join(directory, 'config.json');
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const sessionPath = join(directory, 'session.enc');
const statusPath = join(directory, 'status.json');
const allowedAddress = String(config.tvAddress || '127.0.0.1');
const port = Number(config.port) || 48761;
const seen = new Map();
let cookies = {};

function decrypt(packet) {
    const iv = Buffer.from(packet.iv, 'base64');
    const content = Buffer.from(packet.data, 'base64');
    if (iv.length !== 12 || content.length < 17) throw new Error('Invalid packet');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(content.subarray(content.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(content.subarray(0, content.length - 16)), decipher.final()]).toString('utf8'));
}

function encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
    return JSON.stringify({ iv: iv.toString('base64'), data: body.toString('base64') });
}

function saveSession() {
    writeFileSync(sessionPath, encrypt(cookies));
}

if (existsSync(sessionPath)) {
    try { cookies = decrypt(JSON.parse(readFileSync(sessionPath, 'utf8'))); } catch (error) { cookies = {}; }
}

function updateCookies(headers) {
    for (const line of headers.getSetCookie()) {
        const value = line.split(';')[0];
        const equals = value.indexOf('=');
        if (equals > 0) cookies[value.slice(0, equals)] = value.slice(equals + 1);
    }
}

function cookieHeader() {
    return Object.keys(cookies).map(name => name + '=' + cookies[name]).join('; ');
}

async function site(path, method = 'GET', body = null) {
    const headers = { Accept: 'application/json', Origin: 'https://animecix.tv', Referer: 'https://animecix.tv/login' };
    if (Object.keys(cookies).length) headers.Cookie = cookieHeader();
    if (method === 'POST') {
        headers['Content-Type'] = 'application/json';
        if (cookies['XSRF-TOKEN']) headers['X-XSRF-TOKEN'] = decodeURIComponent(cookies['XSRF-TOKEN']);
    }
    const response = await fetch('https://animecix.tv/secure/' + path, { method, headers, body: body === null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    updateCookies(response.headers);
    let data = null;
    try { data = await response.json(); } catch (error) {}
    return { status: response.status, data };
}

function userFromBootstrap(data) {
    try { return JSON.parse(decodeURIComponent(Buffer.from(data.data, 'base64').toString('utf8'))).user || null; } catch (error) { return null; }
}

async function currentUser() {
    if (!cookies['connect.sid']) return null;
    const result = await site('bootstrap-data');
    if (result.status !== 200) return null;
    const user = userFromBootstrap(result.data);
    if (user && user.id) saveSession();
    return user;
}

async function action(name, payload) {
    if (name === 'login' || name === 'register') {
        const previous = cookies;
        try {
            cookies = {};
            const init = await site('bootstrap-data');
            if (init.status !== 200 || !cookies['XSRF-TOKEN'] || !cookies['connect.sid']) throw new Error('HTTP ' + init.status);
            const result = await site('auth/' + name, 'POST', payload);
            if (result.status < 200 || result.status >= 300) throw new Error('HTTP ' + result.status);
            const user = await currentUser();
            if (!user || !user.id) cookies = previous;
            return { user, status: result.data && result.data.status };
        } catch (error) { cookies = previous; throw error; }
    }
    if (name === 'me') return { user: await currentUser() };
    if (!cookies['connect.sid']) throw new Error('HTTP 401');
    if (name === 'history') {
        const page = Math.max(0, Math.min(9, Number(payload.page) || 0));
        const result = await site('history/get-titles?page=' + page + '&query=');
        if (result.status !== 200) throw new Error('HTTP ' + result.status);
        saveSession();
        return result.data;
    }
    if (name === 'put-title') {
        let result = await site('history/put-title', 'POST', payload.title);
        if (result.status === 403) {
            await site('bootstrap-data');
            result = await site('history/put-title', 'POST', payload.title);
        }
        if (result.status < 200 || result.status >= 300) throw new Error('HTTP ' + result.status);
        saveSession();
        return result.data;
    }
    throw new Error('Invalid action');
}

mkdirSync(directory, { recursive: true });
createServer(async (request, response) => {
    const address = request.socket.remoteAddress || '';
    const allowed = address === allowedAddress || address.endsWith(':' + allowedAddress) || address === '127.0.0.1' || address === '::1';
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (!allowed) { response.writeHead(403).end(); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.method === 'GET' && request.url === '/health') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ready: true })); return; }
    if (request.method !== 'POST' || request.url !== '/api') { response.writeHead(404).end(); return; }
    try {
        let source = '';
        for await (const chunk of request) {
            source += chunk;
            if (source.length > 750000) throw new Error('Request too large');
        }
        const message = decrypt(JSON.parse(source));
        if (!message.nonce || Math.abs(Date.now() - message.time) > 300000 || seen.has(message.nonce)) throw new Error('Invalid request');
        seen.set(message.nonce, Date.now());
        if (seen.size > 1000) for (const [nonce, time] of seen) if (Date.now() - time > 300000) seen.delete(nonce);
        let result;
        try { result = { data: await action(message.action, message.payload || {}) }; }
        catch (error) { result = { error: error.message.startsWith('HTTP ') ? error.message : 'Bağlantı hatası' }; }
        writeFileSync(statusPath, JSON.stringify({ time: Date.now(), address, action: message.action, error: result.error || null }));
        response.setHeader('Content-Type', 'application/json');
        response.end(encrypt(result));
    } catch (error) { response.writeHead(400).end(); }
}).listen(port, '0.0.0.0');
