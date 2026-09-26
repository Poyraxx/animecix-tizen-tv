var bridgeUrl = window.animecixBridgeUrl || 'http://127.0.0.1:48761/api';
var bridgeCryptoKey = null;

function bridgeBytes(text) {
    var binary = unescape(encodeURIComponent(text));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function bridgeText(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(binary));
}

function bridgeBase64(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function bridgeFromBase64(value) {
    var binary = atob(value);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function bridgeKey() {
    if (!bridgeCryptoKey) bridgeCryptoKey = crypto.subtle.importKey('raw', bridgeFromBase64(window.animecixBridgeKey), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return bridgeCryptoKey;
}

function bridgeCall(action, payload, callback, timeout) {
    if (!window.crypto || !crypto.subtle || !window.animecixBridgeKey) { callback(new Error('TV şifreleme desteklemiyor')); return; }
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var nonce = crypto.getRandomValues(new Uint8Array(12));
    bridgeKey().then(function (key) {
        var body = bridgeBytes(JSON.stringify({ action: action, payload: payload || {}, time: Date.now(), nonce: bridgeBase64(nonce) }));
        return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, body);
    }).then(function (encrypted) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', bridgeUrl, true);
        xhr.timeout = timeout || 18000;
        xhr.setRequestHeader('Content-Type', 'text/plain');
        xhr.onload = function () {
            if (xhr.status !== 200) { callback(new Error('Bilgisayar bağlantısı kurulamadı')); return; }
            var packet;
            try { packet = JSON.parse(xhr.responseText); } catch (error) { callback(error); return; }
            bridgeKey().then(function (key) {
                return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bridgeFromBase64(packet.iv) }, key, bridgeFromBase64(packet.data));
            }).then(function (decrypted) {
                var result = JSON.parse(bridgeText(new Uint8Array(decrypted)));
                callback(result.error ? new Error(result.error) : null, result.data);
            }).catch(function (error) { callback(error); });
        };
        xhr.onerror = function () { callback(new Error('Bilgisayar bağlantısı kurulamadı')); };
        xhr.ontimeout = function () { callback(new Error('Bilgisayar bağlantısı zaman aşımı')); };
        xhr.send(JSON.stringify({ iv: bridgeBase64(iv), data: bridgeBase64(new Uint8Array(encrypted)) }));
    }).catch(function (error) { callback(error); });
}
