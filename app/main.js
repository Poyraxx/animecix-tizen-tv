var API = 'https://animecix.tv/secure/';
var state = { view: 'home', lists: null, latest: null, title: null, season: 1, page: 1, episodes: [], source: null, sources: [], videoData: null, quality: null };
var content = document.getElementById('content');
var toast = document.getElementById('toast');
var searchTimer = null;
var toastTimer = null;
var playerTimer = null;
var seekPreviewTimer = null;
var seekCommitTimer = null;
var seekTarget = null;
var previewCues = [];
var requestToken = 0;
var searchMovePending = false;
var progressKey = 'animecix.progress.v1';
var seasonCacheKey = 'animecix.seasons.v1';
var lastProgressSave = 0;
var lastHistorySync = 0;
var accountName = '';
var accountId = '';
var historyAccountId = '';
var historyGeneration = 0;
var remoteProgress = [];
var bridgeActive = false;
var useBridge = false;
var seasonCache = {};
var seasonPending = {};
var homeListsPending = false;
var homeLatestPending = false;
var watchedKey = 'animecix.watched.v1';
var searchHistoryKey = 'animecix.searches.v1';
var currentSearchTerm = '';
var nextTimer = null;
var introSkipSeconds = 85;

try { seasonCache = JSON.parse(localStorage.getItem(seasonCacheKey) || '{}') || {}; } catch (error) { seasonCache = {}; }

try {
    bridgeActive = localStorage.getItem('animecix.bridge') === '1';
    if (bridgeActive) {
        var cachedAccount = JSON.parse(localStorage.getItem('animecix.account') || 'null');
        if (cachedAccount && cachedAccount.id) {
            accountId = String(cachedAccount.id);
            accountName = cachedAccount.name || 'Hesap';
            document.getElementById('accountButton').textContent = 'Hesap';
        }
    }
} catch (error) {}

function progressStorageKey() {
    return progressKey + '.' + (accountId || 'guest');
}

function accountView(name) {
    requestToken++;
    state.view = name;
    clear(content);
    var page = el('div', 'account-page');
    page.appendChild(el('h1', '', name === 'register' ? 'Kayıt Ol' : accountName && name !== 'switch' ? 'Hesap' : 'Giriş Yap'));
    if (name === 'register') {
        var registerEmail = el('input', 'focusable');
        registerEmail.type = 'email';
        registerEmail.placeholder = 'E-posta';
        registerEmail.setAttribute('aria-label', 'E-posta');
        page.appendChild(registerEmail);
        var registerPassword = el('input', 'focusable');
        registerPassword.type = 'password';
        registerPassword.placeholder = 'Şifre';
        registerPassword.setAttribute('aria-label', 'Şifre');
        page.appendChild(registerPassword);
        var confirmation = el('input', 'focusable');
        confirmation.type = 'password';
        confirmation.placeholder = 'Şifre Tekrar';
        confirmation.setAttribute('aria-label', 'Şifre Tekrar');
        page.appendChild(confirmation);
        page.appendChild(button('Kayıt Ol', 'primary', function () {
            var password = registerPassword.value;
            var repeated = confirmation.value;
            registerPassword.value = '';
            confirmation.value = '';
            registerAccount(registerEmail.value.replace(/^\s+|\s+$/g, ''), password, repeated);
        }));
        page.appendChild(button('Giriş Yap', 'secondary', function () { accountView('login'); }));
    } else {
        if (accountName && name !== 'switch') {
            page.appendChild(el('p', '', accountName));
            page.appendChild(button('Hesap Değiştir', 'secondary', function () { accountView('switch'); }));
        } else {
            var email = el('input', 'focusable');
            email.type = 'email';
            email.placeholder = 'E-posta';
            email.setAttribute('aria-label', 'E-posta');
            page.appendChild(email);
            var password = el('input', 'focusable');
            password.type = 'password';
            password.placeholder = 'Şifre';
            password.setAttribute('aria-label', 'Şifre');
            page.appendChild(password);
            page.appendChild(button('Giriş Yap', 'primary', function () {
                var secret = password.value;
                password.value = '';
                loginAccount(email.value.replace(/^\s+|\s+$/g, ''), secret);
            }));
        }
    }
    content.appendChild(page);
    var first = page.querySelector('.focusable');
    if (first) first.focus();
}

function refreshAccount() {
    var hadBridge = bridgeActive;
    bridgeCall('me', {}, function (error, data) {
            if (!error && data && data.user && data.user.id) {
                bridgeActive = true;
                useBridge = true;
                try { localStorage.setItem('animecix.bridge', '1'); } catch (storageError) {}
                setAccount(data.user);
            } else if (!error && hadBridge) {
                bridgeActive = false;
                useBridge = false;
                try { localStorage.removeItem('animecix.bridge'); localStorage.removeItem('animecix.account'); } catch (storageError) {}
                refreshDirectAccount(false);
            } else {
                useBridge = false;
                refreshDirectAccount(hadBridge && !!error);
            }
    }, 25000);
}

function refreshDirectAccount(keepCache) {
    request(API + 'bootstrap-data', function (error, data) {
        if (error) { notify('Hesap kontrol edilemedi'); return; }
        var user = null;
        try { if (data && data.data) user = JSON.parse(decodeURIComponent(atob(data.data))).user; } catch (parseError) {}
        if (user && user.id) setAccount(user);
        else if (!keepCache) setAccount(null);
    });
}

function setAccount(user) {
    accountId = user && user.id ? String(user.id) : '';
    accountName = user && typeof user === 'object' ? user.display_name || user.username || user.email || 'Hesap' : '';
    if (historyAccountId !== accountId) remoteProgress = [];
    historyAccountId = accountId;
    if (accountId) {
        try {
            var oldProgress = localStorage.getItem(progressKey);
            if (oldProgress) {
                if (!localStorage.getItem(progressStorageKey())) localStorage.setItem(progressStorageKey(), oldProgress);
                localStorage.removeItem(progressKey);
            }
            if (useBridge) localStorage.setItem('animecix.account', JSON.stringify({ id: accountId, name: accountName }));
        } catch (storageError) {}
    }
    document.getElementById('accountButton').textContent = accountName ? 'Hesap' : 'Giriş Yap';
    if (state.view === 'login' || state.view === 'switch') accountView('login');
    if (state.view === 'home') renderHome();
    loadAccountHistory();
}

function loadAccountHistory() {
    var currentAccount = accountId;
    var generation = ++historyGeneration;
    if (!currentAccount) return;
    var entries = [];
    function loadPage(page) {
        function received(error, data) {
            if (generation !== historyGeneration || currentAccount !== accountId) return;
            if (error) { if (entries.length) finishAccountHistory(entries); return; }
            var items = data && data.data && data.data.totalData || [];
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                var video = item && item.videos && item.videos[0];
                if (!item || !item.id || !video || video.episode_num == null) continue;
                entries.push({ id: item.id, name: item.name, poster: item.poster, season: video.season_num == null ? 1 : video.season_num, episodeNumber: video.episode_num, episodeName: '', time: Number(item.currentTime) || 0, updated: Number(item.date) || 0 });
            }
            if (items.length >= 10 && page < 9) loadPage(page + 1);
            else finishAccountHistory(entries);
        }
        if (useBridge) bridgeCall('history', { page: page }, received);
        else request(API + 'history/get-titles?page=' + page + '&query=', received);
    }
    loadPage(0);
}

function finishAccountHistory(entries) {
    remoteProgress = entries;
    var combined = entries.concat(readSavedProgress());
    combined.sort(function (left, right) { return (Number(right.updated) || 0) - (Number(left.updated) || 0); });
    var saved = [];
    var seen = {};
    for (var i = 0; i < combined.length; i++) {
        var entry = combined[i];
        if (!entry || !entry.id || entry.episodeNumber == null || seen[String(entry.id)]) continue;
        seen[String(entry.id)] = true;
        saved.push(entry);
    }
    try { localStorage.setItem(progressStorageKey(), JSON.stringify(saved.slice(0, 100))); } catch (error) {}
    if (state.view === 'home') renderHome();
}

function loginAccount(email, password) {
    if (!email || !password) { notify('E-posta ve şifre gir'); return; }
    var credentials = { email: email, password: password, remember: true };
    bridgeCall('login', credentials, function (error, data) {
        if (!error && data && data.user && data.user.id) {
            bridgeActive = true;
            useBridge = true;
            try { localStorage.setItem('animecix.bridge', '1'); } catch (storageError) {}
            setAccount(data.user);
            return;
        }
        if (error && error.message === 'HTTP 401') { notify('E-posta veya şifre hatalı'); return; }
        if (error && error.message.indexOf('HTTP ') === 0) { notify('Giriş yapılamadı: ' + error.message); return; }
        post(API + 'auth/login', credentials, function (directError) {
            if (directError) { notify(directError.message === 'HTTP 401' ? 'E-posta veya şifre hatalı' : 'Bilgisayar bağlantısı gerekli'); return; }
            bridgeActive = false;
            useBridge = false;
            try { localStorage.removeItem('animecix.bridge'); localStorage.removeItem('animecix.account'); } catch (storageError) {}
            refreshAccount();
        });
    });
}

function registerAccount(email, password, confirmation) {
    if (!email || !password || !confirmation) { notify('Bilgileri doldur'); return; }
    if (password !== confirmation) { notify('Şifreler eşleşmiyor'); return; }
    bridgeCall('register', { email: email, password: password, password_confirmation: confirmation }, function (error, data) {
        if (error) { notify(error.message === 'HTTP 422' ? 'Bilgileri kontrol et' : error.message === 'Giriş hazırlığı gerekli' ? 'Giriş hazırlanmadı' : 'Kayıt yapılamadı'); return; }
        if (data && data.status === 'needs_email_verification') {
            notify('E-postanı doğrula');
            accountView('login');
        } else {
            bridgeActive = true;
            useBridge = true;
            try { localStorage.setItem('animecix.bridge', '1'); } catch (storageError) {}
            refreshAccount();
        }
    });
}

function accountAction() {
    accountView('login');
}

function readSavedProgress() {
    try {
        var entries = JSON.parse(localStorage.getItem(progressStorageKey()) || (!accountId ? localStorage.getItem(progressKey) : null) || '[]');
        return Array.isArray(entries) ? entries.filter(function (entry) { return entry && entry.id && entry.episodeNumber != null; }) : [];
    } catch (error) { return []; }
}

function readProgress() {
    var entries = readSavedProgress().concat(remoteProgress);
    entries.sort(function (left, right) { return (Number(right.updated) || 0) - (Number(left.updated) || 0); });
    var merged = [];
    var seen = {};
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (!entry || !entry.id || entry.episodeNumber == null) continue;
        var id = String(entry.id);
        if (seen[id]) {
            if (seen[id].season === entry.season && seen[id].episodeNumber === entry.episodeNumber) seen[id].time = Math.max(Number(seen[id].time) || 0, Number(entry.time) || 0);
        } else {
            seen[id] = entry;
            merged.push(entry);
        }
    }
    return merged.slice(0, 100);
}

function saveProgress(force) {
    var video = document.querySelector('#player video');
    if (!video || !state.title || !state.episode || !isFinite(video.currentTime) || video.currentTime < 3) return;
    var now = Date.now();
    if (!force && now - lastProgressSave < 5000) return;
    lastProgressSave = now;
    markWatched(state.title, state.season, state.episode.episode_number, video.currentTime, video.duration);
    var entries = readSavedProgress().filter(function (entry) { return String(entry.id) !== String(state.title.id); });
    if (!isFinite(video.duration) || video.currentTime < video.duration - 20) {
        entries.unshift({ id: state.title.id, name: state.title.name, poster: state.title.poster, season: state.season, episodeNumber: state.episode.episode_number, episodeName: state.episode.name || '', time: Math.floor(video.currentTime), updated: now });
    }
    try { localStorage.setItem(progressStorageKey(), JSON.stringify(entries.slice(0, 100))); } catch (error) {}
    syncHistory(now, video.currentTime, force);
}

function syncHistory(now, time, force) {
    if (!accountId || !state.source || !state.title) return;
    if (now - lastHistorySync < (force ? 5000 : 60000)) return;
    lastHistorySync = now;
    var title = JSON.parse(JSON.stringify(state.title));
    title.date = now;
    title.currentTime = Math.floor(time);
    title.season = null;
    title.seasons = null;
    title.videos = [state.source];
    title.episodes = [];
    title.episode_images = [];
    var saved = function (error) {
        if (error) lastHistorySync = 0;
    };
    if (useBridge) bridgeCall('put-title', { title: title }, saved);
    else post(API + 'history/put-title', title, saved);
}

function resumeEpisode(entry) {
    state.title = { id: entry.id, name: entry.name, poster: entry.poster };
    state.season = entry.season == null ? 1 : entry.season;
    state.episodes = [];
    fetchSeason(entry.id, state.season, function () {});
    openEpisode({ episode_number: entry.episodeNumber, name: entry.episodeName }, entry.time);
}

function progressRow(entries) {
    var section = el('section', 'row');
    section.appendChild(el('h2', '', 'Kaldığın yerden devam et'));
    var cards = el('div', 'cards');
    for (var i = 0; i < entries.length; i++) {
        (function (entry) {
            var node = button('', 'card', function () { resumeEpisode(entry); });
            var img = el('img');
            img.alt = '';
            img.src = imageUrl(entry.poster, 'w342') || '';
            node.appendChild(img);
            node.appendChild(el('span', 'card-name', entry.name || ''));
            node.appendChild(el('span', 'card-meta', (entry.season == null ? 1 : entry.season) + '. Sezon · ' + entry.episodeNumber + '. Bölüm'));
            cards.appendChild(node);
        })(entries[i]);
    }
    section.appendChild(cards);
    return section;
}

function el(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
}

function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
}

function button(text, className, action) {
    var node = el('button', 'focusable ' + (className || ''), text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
}

function imageUrl(url, width) {
    if (!url || !/^https:\/\//i.test(url)) return '';
    var sized = url.replace('/t/p/original/', '/t/p/' + width + '/');
    if (/^https:\/\/image\.tmdb\.org\//i.test(sized)) return 'https://wsrv.nl/?url=' + encodeURIComponent(sized) + '&w=' + width.replace(/\D/g, '');
    return sized;
}

function request(url, callback, withHeader) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    function finish(error, data) {
        if (finished) return;
        finished = true;
        callback(error, data);
    }
    xhr.open('GET', url, true);
    xhr.withCredentials = !!window.tizen;
    xhr.timeout = 18000;
    xhr.setRequestHeader('Accept', 'application/json');
    if (withHeader) xhr.setRequestHeader('X-E-H', 'tv.client');
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 0) { setTimeout(function () { finish(new Error('HTTP 0')); }, 0); return; }
        if (xhr.status >= 200 && xhr.status < 300) {
            var data;
            try { data = JSON.parse(xhr.responseText); }
            catch (error) { finish(new Error('Geçersiz yanıt')); return; }
            finish(null, data);
        } else {
            finish(new Error('HTTP ' + xhr.status));
        }
    };
    xhr.ontimeout = function () { finish(new Error('Zaman aşımı')); };
    xhr.send();
}

function errorText(error) {
    var text = error && error.message ? error.message : '';
    var match = text.match(/^HTTP (\d+)$/);
    var status = match ? Number(match[1]) : -1;
    if (text === 'Zaman aşımı') return 'Sunucu zamanında yanıt vermedi. Site yavaş ya da kapalı olabilir.';
    if (status === 0) return 'Sunucuya bağlanılamadı. TV\'nin internet bağlantısını kontrol et.';
    if (status >= 500) return 'AnimeciX sunucusu şu an yanıt vermiyor (HTTP ' + status + '). Site geçici olarak kapalı olabilir.';
    if (status === 404) return 'İçerik bulunamadı (HTTP 404).';
    if (status === 403 || status === 429) return 'Sunucu isteği reddetti (HTTP ' + status + '). Biraz sonra tekrar dene.';
    if (status > 0) return 'İstek başarısız oldu (HTTP ' + status + ').';
    if (text === 'Geçersiz yanıt') return 'Sunucudan beklenmeyen bir yanıt geldi.';
    return text || 'Bilinmeyen bir hata oluştu.';
}

function errorBox(text, retry, backLabel, backAction) {
    var box = el('div', 'error-box');
    box.appendChild(el('div', 'error-text', text));
    var actions = el('div', 'error-actions');
    if (retry) actions.appendChild(button('Tekrar Dene', 'primary', retry));
    if (backLabel && backAction) actions.appendChild(button(backLabel, 'secondary', backAction));
    box.appendChild(actions);
    return box;
}

function post(url, payload, callback) {
    var token = '';
    try { token = localStorage.getItem('animecix.xsrf') || ''; } catch (error) {}
    if (!token || !window.tizen) { callback(new Error('Giriş hazırlığı gerekli')); return; }
    var xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    xhr.timeout = 18000;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('X-XSRF-TOKEN', token);
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (error) {}
        callback(xhr.status >= 200 && xhr.status < 300 ? null : new Error('HTTP ' + xhr.status), data);
    };
    xhr.ontimeout = function () { callback(new Error('Zaman aşımı')); };
    xhr.send(JSON.stringify(payload));
}

function notify(message) {
    toast.textContent = message;
    toast.className = 'visible';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.className = ''; }, 4500);
}

function loading() {
    clear(content);
    content.appendChild(el('div', 'loading'));
}

function message(text) {
    clear(content);
    content.appendChild(el('div', 'message', text));
}

function showHome() {
    requestToken++;
    state.view = 'home';
    state.title = null;
    document.getElementById('topbar').style.display = 'flex';
    if (!state.lists || !state.latest) state.homeError = null;
    if (!state.lists && !homeListsPending) {
        homeListsPending = true;
        request(API + 'homepage/lists-guests', function (error, data) {
            homeListsPending = false;
            if (!error && data && data.lists) state.lists = data.lists;
            else state.homeError = error || new Error('Geçersiz yanıt');
            if (state.view === 'home') renderHome();
        });
    }
    if (!state.latest && !homeLatestPending) {
        homeLatestPending = true;
        request(API + 'last-episodes?page=1', function (error, data) {
            homeLatestPending = false;
            if (!error && data && data.data) state.latest = data.data;
            else state.homeError = error || new Error('Geçersiz yanıt');
            if (state.view === 'home') renderHome();
        });
    }
    renderHome();
    if (document.activeElement === document.body || !document.body.contains(document.activeElement)) document.getElementById('brand').focus();
}

function hero(item, label, action) {
    var wrap = el('section', 'hero');
    var bg = el('div', 'hero-backdrop');
    var backdrop = imageUrl(item.backdrop || item.title_poster || item.poster, 'w1280');
    if (backdrop) bg.style.backgroundImage = 'url("' + backdrop + '")';
    wrap.appendChild(bg);
    wrap.appendChild(el('div', 'hero-shade'));
    var inner = el('div', 'hero-content');
    if (label) inner.appendChild(el('div', 'eyebrow', label));
    inner.appendChild(el('h1', '', item.name || item.title_name || ''));
    if (item.description) inner.appendChild(el('p', '', item.description));
    inner.appendChild(button('Bölümler', 'primary', action));
    wrap.appendChild(inner);
    return wrap;
}

function card(item, episode) {
    var title = episode ? item.title_name : item.name;
    var poster = episode ? item.title_poster : item.poster;
    var node = button('', 'card', function () {
        openTitle(episode ? { id: item.title_id, name: item.title_name, poster: item.title_poster } : item);
    });
    var img = el('img');
    img.alt = '';
    img.src = imageUrl(poster, 'w342') || '';
    node.appendChild(img);
    node.appendChild(el('span', 'card-name', title || ''));
    if (episode) node.appendChild(el('span', 'card-meta', (item.season_number || 1) + '. Sezon · ' + item.episode_number + '. Bölüm'));
    else if (item.year) node.appendChild(el('span', 'card-meta', item.year));
    return node;
}

function row(name, items, episode) {
    var section = el('section', 'row');
    section.appendChild(el('h2', '', name));
    var cards = el('div', 'cards');
    var max = Math.min(items.length, 24);
    for (var i = 0; i < max; i++) cards.appendChild(card(items[i], episode));
    section.appendChild(cards);
    return section;
}

function renderHome() {
    if (state.view !== 'home') return;
    var focused = document.activeElement;
    var focusedRow = focused && focused.closest ? focused.closest('.row') : null;
    var focusedName = focusedRow && focusedRow.querySelector('h2') ? focusedRow.querySelector('h2').textContent : '';
    var focusedIndex = -1;
    if (focusedRow && focused.className.indexOf('card') !== -1) {
        var oldCards = focusedRow.querySelectorAll('.card');
        for (var k = 0; k < oldCards.length; k++) if (oldCards[k] === focused) focusedIndex = k;
    }
    clear(content);
    var lists = state.lists || [];
    var latest = state.latest || [];
    var featured = lists.length && lists[0].items && lists[0].items.length ? lists[0].items[0] : null;
    if (featured) content.appendChild(hero(featured, lists[0].name, function () { openTitle(featured); }));
    var progress = readProgress();
    if (progress.length) content.appendChild(progressRow(progress));
    if (!lists.length && !latest.length) {
        if (homeListsPending || homeLatestPending) {
            if (!progress.length) { content.appendChild(el('div', 'loading')); return; }
        } else if (state.homeError) {
            var homeBox = errorBox(errorText(state.homeError), function () { showHome(); });
            content.appendChild(homeBox);
            if (focused === document.body || !document.body.contains(focused) || (focused && focused.closest && focused.closest('.error-box'))) {
                var retryButton = homeBox.querySelector('button');
                if (retryButton) retryButton.focus();
            }
            return;
        }
    }
    if (latest.length) content.appendChild(row('Son Eklenen Bölümler', latest, true));
    for (var i = 0; i < lists.length; i++) {
        if (lists[i].items && lists[i].items.length) content.appendChild(row(lists[i].name, lists[i].items, false));
    }
    if (focusedIndex >= 0) {
        var rows = content.querySelectorAll('.row');
        for (var j = 0; j < rows.length; j++) {
            if (rows[j].querySelector('h2').textContent === focusedName) {
                var cards = rows[j].querySelectorAll('.card');
                if (cards[focusedIndex]) cards[focusedIndex].focus();
                break;
            }
        }
    }
}

function openSearch() {
    requestToken++;
    state.view = 'search';
    searchMovePending = false;
    clear(content);
    var page = el('div', 'search-page');
    var input = el('input', 'focusable');
    input.type = 'search';
    input.placeholder = 'Bir anime arayın...';
    input.setAttribute('aria-label', 'Bir anime arayın');
    page.appendChild(input);
    var results = el('div');
    page.appendChild(results);
    content.appendChild(page);
    currentSearchTerm = '';
    function runSearch(term) {
        var token = ++requestToken;
        currentSearchTerm = '';
        request(API + 'search/' + encodeURIComponent(term) + '?type=undefined&limit=24&provider=null', function (error, data) {
            if (state.view !== 'search' || token !== requestToken) return;
            clear(results);
            if (error || !data || !data.results) {
                results.appendChild(errorBox('Arama yapılamadı. ' + errorText(error || new Error('Geçersiz yanıt')), function () { runSearch(term); }));
                if (searchMovePending) { searchMovePending = false; var retry = results.querySelector('button'); if (retry) retry.focus(); }
                return;
            }
            currentSearchTerm = term;
            if (!data.results.length) { results.appendChild(el('div', 'message', '"' + term + '" için sonuç bulunamadı')); searchMovePending = false; return; }
            results.appendChild(row('Sonuçlar', data.results, false));
            if (searchMovePending) {
                searchMovePending = false;
                var first = results.querySelector('.card');
                if (first) { first.focus(); first.scrollIntoView(false); }
            }
        });
    }
    function showHistory() {
        clear(results);
        var terms = readSearches();
        if (!terms.length) return;
        var section = el('section', 'search-history');
        section.appendChild(el('h2', '', 'Son aramalar'));
        var list = el('div', 'history-list');
        for (var i = 0; i < terms.length; i++) {
            (function (term) {
                list.appendChild(button(term, 'history-item', function () {
                    clearTimeout(searchTimer);
                    input.value = term;
                    searchMovePending = true;
                    clear(results);
                    results.appendChild(el('div', 'loading'));
                    runSearch(term);
                }));
            })(terms[i]);
        }
        list.appendChild(button('Geçmişi Temizle', 'history-clear', function () {
            try { localStorage.removeItem(searchHistoryKey); } catch (error) {}
            showHistory();
            input.focus();
        }));
        section.appendChild(list);
        results.appendChild(section);
    }
    input.addEventListener('input', function () {
        clearTimeout(searchTimer);
        var term = input.value.replace(/^\s+|\s+$/g, '');
        if (term.length < 2) { searchMovePending = false; requestToken++; currentSearchTerm = ''; showHistory(); return; }
        searchTimer = setTimeout(function () { runSearch(term); }, 400);
    });
    showHistory();
    input.focus();
}

function readSearches() {
    try {
        var terms = JSON.parse(localStorage.getItem(searchHistoryKey) || '[]');
        return Array.isArray(terms) ? terms.filter(function (term) { return typeof term === 'string' && term.length > 1; }).slice(0, 10) : [];
    } catch (error) { return []; }
}

function saveSearch(term) {
    term = String(term || '').replace(/^\s+|\s+$/g, '');
    if (term.length < 2) return;
    var lower = term.toLocaleLowerCase('tr');
    var terms = [term].concat(readSearches().filter(function (old) { return old.toLocaleLowerCase('tr') !== lower; }));
    try { localStorage.setItem(searchHistoryKey, JSON.stringify(terms.slice(0, 10))); } catch (error) {}
}

function progressFor(id) {
    var entries = readProgress();
    for (var i = 0; i < entries.length; i++) if (String(entries[i].id) === String(id)) return entries[i];
    return null;
}

function openTitle(item) {
    if (!item || !item.id) return;
    if (state.view === 'search' && currentSearchTerm) saveSearch(currentSearchTerm);
    requestToken++;
    var saved = progressFor(item.id);
    var season = saved && saved.season != null ? Number(saved.season) || 1 : 1;
    state.view = 'detail';
    state.title = item;
    state.season = season;
    state.page = 1;
    state.episodes = [];
    state.detailError = null;
    renderDetail();
    loadSeason(season);
}

function watchedStorageKey() {
    return watchedKey + '.' + (accountId || 'guest');
}

function readWatched() {
    try {
        var data = JSON.parse(localStorage.getItem(watchedStorageKey()) || '{}');
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) { return {}; }
}

function watchedFor(id) {
    var entry = readWatched()[String(id)];
    return entry && entry.e && typeof entry.e === 'object' ? entry.e : {};
}

function markWatched(title, season, number, time, duration) {
    if (!title || !title.id || number == null || !isFinite(time) || !isFinite(duration) || duration <= 0) return;
    var all = readWatched();
    var id = String(title.id);
    var entry = all[id] && all[id].e ? all[id] : { e: {} };
    var key = season + ':' + number;
    var old = entry.e[key] || {};
    var done = !!old.done || time >= duration * 0.9 || (duration > 600 && duration - time <= 120);
    entry.e[key] = { t: Math.floor(time), d: Math.floor(duration), done: done };
    entry.u = Date.now();
    all[id] = entry;
    var ids = Object.keys(all);
    if (ids.length > 150) {
        ids.sort(function (left, right) { return (all[right].u || 0) - (all[left].u || 0); });
        for (var i = 150; i < ids.length; i++) delete all[ids[i]];
    }
    try { localStorage.setItem(watchedStorageKey(), JSON.stringify(all)); } catch (error) {}
}

function seasonKey(id, number) {
    return String(id) + ':' + String(number);
}

function cachedSeason(id, number) {
    var key = seasonKey(id, number);
    var cached = seasonCache[key];
    if (!cached || !cached.savedAt || Date.now() - cached.savedAt > 21600000) {
        if (cached) delete seasonCache[key];
        return null;
    }
    return cached;
}

function storeSeason(title, number, episodes, page) {
    var key = seasonKey(title.id, number);
    seasonCache[key] = {
        savedAt: Date.now(),
        page: page || 1,
        episodes: episodes || [],
        title: {
            id: title.id,
            name: title.name,
            poster: title.poster,
            backdrop: title.backdrop,
            description: title.description,
            year: title.year,
            seasons: title.seasons || [],
            season: title.season || null
        }
    };
    var keys = Object.keys(seasonCache);
    keys.sort(function (left, right) { return seasonCache[right].savedAt - seasonCache[left].savedAt; });
    for (var i = 20; i < keys.length; i++) delete seasonCache[keys[i]];
    try { localStorage.setItem(seasonCacheKey, JSON.stringify(seasonCache)); } catch (error) {
        for (var j = 8; j < keys.length; j++) delete seasonCache[keys[j]];
        try { localStorage.setItem(seasonCacheKey, JSON.stringify(seasonCache)); } catch (storageError) {}
    }
    return seasonCache[key];
}

function fetchSeason(id, number, callback) {
    var cached = cachedSeason(id, number);
    if (cached) { callback(null, cached); return; }
    var key = seasonKey(id, number);
    if (seasonPending[key]) { seasonPending[key].push(callback); return; }
    seasonPending[key] = [callback];
    request(API + 'titles/' + encodeURIComponent(id) + '?seasonNumber=' + encodeURIComponent(number) + '&page=1', function (error, data) {
        var result = null;
        if (!error && data && data.title && Number(data.title.id) === Number(id)) {
            var pages = data.title.season && data.title.season.episodePagination;
            result = storeSeason(data.title, number, pages && pages.data ? pages.data : [], 1);
        }
        var callbacks = seasonPending[key] || [];
        delete seasonPending[key];
        var failure = error || (!result ? new Error('Geçersiz yanıt') : null);
        for (var i = 0; i < callbacks.length; i++) callbacks[i](failure, result);
    }, true);
}

function prefetchSeasons(id, seasons, current) {
    var numbers = [];
    for (var i = 0; i < seasons.length; i++) if (seasons[i].number !== current && !cachedSeason(id, seasons[i].number)) numbers.push(seasons[i].number);
    numbers.sort(function (left, right) { return Math.abs(left - current) - Math.abs(right - current); });
    numbers = numbers.slice(0, 4);
    var index = 0;
    var active = 0;
    function next() {
        while (active < 2 && index < numbers.length) {
            active++;
            fetchSeason(id, numbers[index++], function () { active--; next(); });
        }
    }
    next();
}

function loadSeason(number) {
    var token = ++requestToken;
    var id = state.title.id;
    state.season = number;
    state.page = 1;
    state.episodes = [];
    state.detailError = null;
    renderDetail();
    fetchSeason(id, number, function (error, cached) {
        if (state.view !== 'detail' || token !== requestToken) return;
        if (error || !cached) { state.detailError = error || new Error('Geçersiz yanıt'); renderDetail(); return; }
        state.title = cached.title;
        state.episodes = cached.episodes.slice();
        state.page = cached.page || 1;
        renderDetail();
        prefetchSeasons(id, state.title.seasons || [], number);
    });
}

function loadMore() {
    var nextPage = state.page + 1;
    var token = ++requestToken;
    var id = state.title.id;
    request(API + 'titles/' + encodeURIComponent(id) + '?seasonNumber=' + state.season + '&page=' + nextPage, function (error, data) {
        if (state.view !== 'detail' || token !== requestToken) return;
        if (error || !data || !data.title || !data.title.season || !data.title.season.episodePagination) { notify('Bölümler yüklenemedi. ' + errorText(error || new Error('Geçersiz yanıt'))); return; }
        var extra = data.title.season.episodePagination.data || [];
        for (var i = 0; i < extra.length; i++) state.episodes.push(extra[i]);
        state.title.season = data.title.season;
        state.page = nextPage;
        storeSeason(state.title, state.season, state.episodes, state.page);
        renderDetail();
    }, true);
}

function renderDetail() {
    if (state.view !== 'detail') return;
    var hadFocus = content.contains(document.activeElement);
    clear(content);
    var detail = el('div', 'detail');
    var title = state.title;
    detail.appendChild(hero(title, title.year || '', function () {
        var first = content.querySelector('.episode');
        if (first) first.focus();
    }));
    var seasons = title.seasons || [];
    if (seasons.length > 1) {
        var bar = el('div', 'season-bar');
        for (var i = 0; i < seasons.length; i++) {
            (function (number) {
                var current = number === state.season;
                bar.appendChild(button(number + '. Sezon', current ? 'active' : '', function () { loadSeason(number); }));
            })(seasons[i].number);
        }
        detail.appendChild(bar);
    }
    var episodes = el('div', 'episode-list');
    if (state.episodes.length) {
        var watched = watchedFor(title.id);
        var saved = progressFor(title.id);
        var savedHere = saved && Number(saved.season == null ? 1 : saved.season) === Number(state.season) ? saved : null;
        var resumeNumber = null;
        var lastDone = null;
        for (var r = 0; r < state.episodes.length; r++) {
            var info = watched[state.season + ':' + state.episodes[r].episode_number];
            if (info && info.done && (lastDone === null || Number(state.episodes[r].episode_number) > lastDone)) lastDone = Number(state.episodes[r].episode_number);
        }
        if (savedHere) resumeNumber = Number(savedHere.episodeNumber);
        else if (lastDone !== null) {
            for (var n = 0; n < state.episodes.length; n++) {
                var number = Number(state.episodes[n].episode_number);
                if (number > lastDone && (resumeNumber === null || number < resumeNumber)) resumeNumber = number;
            }
        }
        for (var j = 0; j < state.episodes.length; j++) {
            (function (episode) {
                var info = watched[state.season + ':' + episode.episode_number] || null;
                var resumeTime = 0;
                if (info && !info.done && info.t > 0) resumeTime = info.t;
                else if (!info && savedHere && Number(savedHere.episodeNumber) === Number(episode.episode_number)) resumeTime = Number(savedHere.time) || 0;
                var isResume = resumeNumber !== null && Number(episode.episode_number) === resumeNumber;
                var node = button('', 'episode' + (info && info.done ? ' watched' : '') + (isResume ? ' resume' : ''), function () { openEpisode(episode, resumeTime); });
                node.appendChild(el('span', 'episode-num', episode.episode_number));
                var text = el('span', 'episode-text');
                text.appendChild(el('span', 'episode-title', episode.name || 'Bölüm ' + episode.episode_number));
                if (isResume) text.appendChild(el('span', 'episode-meta', resumeTime > 0 ? 'Kaldığın yer · ' + formatTime(resumeTime) : 'Sıradaki bölüm'));
                else if (resumeTime > 0) text.appendChild(el('span', 'episode-meta', 'Yarıda kaldı · ' + formatTime(resumeTime)));
                node.appendChild(text);
                if (info && info.done) node.appendChild(el('span', 'episode-check', '✓'));
                if (resumeTime > 0) {
                    var duration = info && info.d ? info.d : 0;
                    var track = el('span', 'episode-progress');
                    var fill = el('span');
                    fill.style.width = (duration ? Math.min(100, Math.max(3, resumeTime / duration * 100)) : 50) + '%';
                    track.appendChild(fill);
                    node.appendChild(track);
                }
                episodes.appendChild(node);
            })(state.episodes[j]);
        }
    } else if (state.detailError) {
        episodes.appendChild(errorBox('Bölümler yüklenemedi. ' + errorText(state.detailError), function () { loadSeason(state.season); }, 'Ana Sayfa', function () { showHome(); }));
    } else episodes.appendChild(el('div', 'message', 'Bölümler yükleniyor'));
    detail.appendChild(episodes);
    var pageInfo = title.season && title.season.episodePagination;
    if (pageInfo && state.episodes.length && state.episodes.length < pageInfo.total) detail.appendChild(button('Daha Fazla', 'secondary load-more', loadMore));
    content.appendChild(detail);
    if (hadFocus || document.activeElement === document.body) {
        var target = content.querySelector('.episode.resume') || content.querySelector('.episode') || content.querySelector('.episode-list .error-box button') || content.querySelector('.hero button');
        if (target) { target.focus(); if (target.className.indexOf('resume') !== -1) target.scrollIntoView(false); }
    }
}

function openEpisode(episode, resumeTime) {
    if (!episode) return;
    var token = ++requestToken;
    state.view = 'player';
    state.episode = episode;
    state.resumeTime = resumeTime || 0;
    lastHistorySync = 0;
    state.sources = [];
    state.failedSources = [];
    state.videoData = null;
    clearNext();
    renderPlayer();
    var url = API + 'titles/' + encodeURIComponent(state.title.id) + '?titleId=' + encodeURIComponent(state.title.id) + '&seasonNumber=' + state.season + '&episodeNumber=' + episode.episode_number + '&page=1&perPage=100';
    request(url, function (error, data) {
        if (state.view !== 'player' || token !== requestToken) return;
        var retry = function () { openEpisode(episode, state.resumeTime); };
        if (error || !data || !data.title || Number(data.title.id) !== Number(state.title.id)) {
            playerError('Video kaynakları yüklenemedi. ' + errorText(error || new Error('Geçersiz yanıt')), retry);
            return;
        }
        var oldSeasons = state.title.seasons;
        state.title = data.title;
        if ((!state.title.seasons || !state.title.seasons.length) && oldSeasons) state.title.seasons = oldSeasons;
        var videos = data.title.videos || [];
        var sources = videos.filter(function (video) { return video && video.url && video.category === 'full'; });
        if (!sources.length) sources = videos.filter(function (video) { return video && video.url; });
        if (!sources.length) { playerError('Bu bölüm için video kaynağı bulunamadı.', retry); return; }
        var direct = sources.filter(function (video) { return /tau-video\.xyz\/embed\//.test(video.url); });
        var others = sources.filter(function (video) { return !/tau-video\.xyz\/embed\//.test(video.url); });
        state.sources = direct.concat(others);
        selectSource(state.sources[0]);
    }, true);
}

function playerError(text, retry) {
    var player = document.getElementById('player');
    if (!player) { notify(text); return; }
    var old = player.querySelector('.player-error');
    if (old) player.removeChild(old);
    clearTimeout(toastTimer);
    toast.className = '';
    var overlay = el('div', 'player-error');
    overlay.appendChild(errorBox(text, retry ? function () { player.removeChild(overlay); retry(); } : null, 'Geri', function () { closePlayer(); }));
    player.appendChild(overlay);
    var first = overlay.querySelector('button');
    if (first) first.focus();
    showControls();
}

function sourceFailed(source, reason) {
    if (state.view !== 'player' || state.source !== source) return;
    if (state.failedSources.indexOf(source) === -1) state.failedSources.push(source);
    var video = document.querySelector('#player video');
    if (video && isFinite(video.currentTime) && video.currentTime > 5) state.resumeTime = video.currentTime;
    var next = null;
    for (var i = 0; i < state.sources.length; i++) if (state.failedSources.indexOf(state.sources[i]) === -1) { next = state.sources[i]; break; }
    if (next) {
        notify(reason + '. Sıradaki kaynak deneniyor: ' + (next.name || 'Video'));
        selectSource(next);
        return;
    }
    var episode = state.episode;
    playerError((state.sources.length > 1 ? 'Bu bölümün ' + state.sources.length + ' kaynağının hiçbiri açılamadı. Son hata: ' : '') + reason + '.', function () { openEpisode(episode, state.resumeTime); });
}

function clearNext() {
    clearInterval(nextTimer);
    nextTimer = null;
    var overlay = document.querySelector('#player .next-overlay');
    if (overlay) overlay.parentNode.removeChild(overlay);
}

function findNextEpisode(callback) {
    var title = state.title;
    var season = state.season;
    var current = Number(state.episode && state.episode.episode_number);
    function smallestAfter(list, after) {
        var best = null;
        for (var i = 0; i < list.length; i++) {
            var number = Number(list[i] && list[i].episode_number);
            if (isFinite(number) && number > after && (!best || number < Number(best.episode_number))) best = list[i];
        }
        return best;
    }
    function nextSeason() {
        var seasons = title.seasons && title.seasons.length ? title.seasons : (((cachedSeason(title.id, season) || {}).title || {}).seasons || []);
        var number = null;
        for (var i = 0; i < seasons.length; i++) {
            var value = Number(seasons[i].number);
            if (value > season && (number === null || value < number)) number = value;
        }
        if (number === null) { callback(null); return; }
        fetchSeason(title.id, number, function (error, cached) {
            if (error || !cached || !cached.episodes.length) { callback(null); return; }
            callback(smallestAfter(cached.episodes, -Infinity), number, cached);
        });
    }
    function search() {
        var embedded = title.season && title.season.episodePagination && title.season.episodePagination.data || [];
        var found = smallestAfter(state.episodes.concat(embedded), current);
        if (found) { callback(found, season); return; }
        var pages = title.season && title.season.episodePagination;
        if (pages && pages.total && state.episodes.length && state.episodes.length < pages.total) {
            var nextPage = (state.page || 1) + 1;
            request(API + 'titles/' + encodeURIComponent(title.id) + '?seasonNumber=' + season + '&page=' + nextPage, function (error, data) {
                var extra = !error && data && data.title && data.title.season && data.title.season.episodePagination && data.title.season.episodePagination.data || [];
                if (extra.length && state.season === season) {
                    for (var i = 0; i < extra.length; i++) state.episodes.push(extra[i]);
                    state.page = nextPage;
                    storeSeason(title, season, state.episodes, nextPage);
                }
                found = smallestAfter(extra, current);
                if (found) callback(found, season); else nextSeason();
            }, true);
            return;
        }
        nextSeason();
    }
    if (state.episodes.length) { search(); return; }
    fetchSeason(title.id, season, function (error, cached) {
        if (!error && cached && state.season === season && !state.episodes.length) {
            state.episodes = cached.episodes.slice();
            state.page = cached.page || 1;
        }
        search();
    });
}

function goToEpisode(episode, season, cached) {
    clearNext();
    if (season !== state.season) {
        state.season = season;
        state.episodes = cached ? cached.episodes.slice() : [];
        state.page = cached ? cached.page || 1 : 1;
    }
    var info = watchedFor(state.title.id)[season + ':' + episode.episode_number];
    openEpisode(episode, info && !info.done && info.t > 0 ? info.t : 0);
}

function playNext() {
    if (state.view !== 'player' || !state.episode) return;
    var token = requestToken;
    var episode = state.episode;
    notify('Sonraki bölüm aranıyor');
    findNextEpisode(function (next, season, cached) {
        if (state.view !== 'player' || token !== requestToken || state.episode !== episode) return;
        if (!next) { notify('Bu dizinin son bölümündesin'); return; }
        goToEpisode(next, season, cached);
    });
}

function episodeEnded() {
    if (state.view !== 'player' || !state.episode) return;
    var token = requestToken;
    var episode = state.episode;
    findNextEpisode(function (next, season, cached) {
        if (state.view !== 'player' || token !== requestToken || state.episode !== episode) return;
        if (!next) { notify('Son bölümü izledin'); showControls(); return; }
        showNextOverlay(next, season, cached);
    });
}

function showNextOverlay(next, season, cached) {
    var player = document.getElementById('player');
    if (!player) return;
    clearNext();
    var overlay = el('div', 'next-overlay');
    overlay.appendChild(el('div', 'next-heading', 'Sıradaki bölüm'));
    overlay.appendChild(el('div', 'next-name', (season !== state.season ? season + '. Sezon · ' : '') + next.episode_number + '. Bölüm' + (next.name ? ' · ' + next.name : '')));
    var count = el('div', 'next-count');
    overlay.appendChild(count);
    var actions = el('div', 'next-actions');
    actions.appendChild(button('Şimdi Oynat', 'primary', function () { goToEpisode(next, season, cached); }));
    actions.appendChild(button('İptal', 'secondary', function () { clearNext(); showControls(); var bar = document.querySelector('#player .seek-bar'); if (bar) bar.focus(); }));
    overlay.appendChild(actions);
    player.appendChild(overlay);
    var seconds = 10;
    count.textContent = seconds + ' saniye içinde başlayacak';
    nextTimer = setInterval(function () {
        seconds--;
        if (seconds <= 0) { goToEpisode(next, season, cached); return; }
        count.textContent = seconds + ' saniye içinde başlayacak';
    }, 1000);
    actions.firstChild.focus();
    showControls();
}

function skipIntro() {
    var video = document.querySelector('#player video');
    if (!video || !isFinite(video.duration) || video.duration <= 0) { notify('Önce video açılmalı'); return; }
    seekBy(video, introSkipSeconds);
    notify('Giriş atlandı (+' + introSkipSeconds + ' sn)');
}

function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor(seconds / 60);
    var rest = Math.floor(seconds % 60);
    if (hours) return hours + ':' + (minutes % 60 < 10 ? '0' : '') + minutes % 60 + ':' + (rest < 10 ? '0' : '') + rest;
    return minutes + ':' + (rest < 10 ? '0' : '') + rest;
}

function renderPlayer() {
    clear(content);
    document.getElementById('app').className = 'playing';
    document.getElementById('topbar').style.display = 'none';
    var player = el('div', 'player');
    player.id = 'player';
    var top = el('div', 'player-top');
    top.appendChild(button('Geri', '', function () { closePlayer(); }));
    top.appendChild(el('div', 'player-title', state.title.name + ' · ' + state.season + '. Sezon ' + state.episode.episode_number + '. Bölüm'));
    var skip = button('Girişi Atla', 'skip-intro key-yellow', skipIntro);
    skip.style.display = 'none';
    top.appendChild(skip);
    top.appendChild(button('Sonraki', 'key-blue', playNext));
    top.appendChild(button('Kaynak', 'key-red', showSources));
    top.appendChild(button('Kalite', 'key-green', showQualities));
    player.appendChild(top);
    player.appendChild(el('div', 'skip-hint', 'Sarı tuş: Girişi atla (+' + introSkipSeconds + ' sn)'));
    var bottom = el('div', 'player-bottom');
    bottom.appendChild(button('Oynat', 'play-button', togglePlayback));
    var progress = button('', 'seek-bar', function (event) {
        if (!event.detail) { if (seekTarget !== null) commitSeek(); else togglePlayback(); return; }
        var video = player.querySelector('video');
        if (!video || !isFinite(video.duration) || video.duration <= 0) return;
        var rect = progress.getBoundingClientRect();
        seekTo(video, (event.clientX - rect.left) / rect.width * video.duration);
    });
    progress.setAttribute('aria-label', 'Video süresi');
    progress.appendChild(el('span'));
    bottom.appendChild(progress);
    bottom.appendChild(el('div', 'time', '0:00 / 0:00'));
    player.appendChild(bottom);
    var preview = el('div', 'seek-preview');
    var image = el('img');
    image.alt = '';
    preview.appendChild(image);
    preview.appendChild(el('div', 'seek-preview-time', '0:00'));
    player.appendChild(preview);
    content.appendChild(player);
    progress.focus();
}

function selectSource(source) {
    state.source = source;
    previewCues = [];
    seekTarget = null;
    clearTimeout(seekCommitTimer);
    var player = document.getElementById('player');
    if (!player) return;
    var oldMedia = player.querySelector('video,iframe');
    if (oldMedia) player.removeChild(oldMedia);
    var choice = player.querySelector('.choice');
    if (choice) player.removeChild(choice);
    var errorOverlay = player.querySelector('.player-error');
    if (errorOverlay) player.removeChild(errorOverlay);
    if (/tau-video\.xyz\/embed\//.test(source.url)) {
        var match = source.url.match(/\/embed\/([^/?#]+)/);
        if (!match) { sourceFailed(source, 'Video adresi geçersiz'); return; }
        loadPreviewCues(match[1], source);
        request('https://tau-video.xyz/api/video/' + encodeURIComponent(match[1]), function (error, data) {
            if (state.view !== 'player' || state.source !== source) return;
            if (error || !data || (!data.urls && !data.hls)) { sourceFailed(source, (source.name || 'Kaynak') + ' açılamadı'); return; }
            state.videoData = data;
            var urls = data.urls || [];
            var selected = urls[0];
            for (var i = 0; i < urls.length; i++) if (urls[i].label === '720p') selected = urls[i];
            if (selected) playUrl(selected.url, selected.label);
            else if (data.hls) playUrl(data.hls, 'HLS');
            else sourceFailed(source, (source.name || 'Kaynak') + ' video içermiyor');
        });
    } else {
        state.videoData = null;
        var frame = el('iframe');
        frame.src = source.url;
        frame.allow = 'autoplay; fullscreen';
        player.insertBefore(frame, player.firstChild);
        notify(source.name || 'Video');
    }
}

function playUrl(url, label) {
    var source = state.source;
    if (!/^https:\/\//i.test(url)) { sourceFailed(source, 'Video adresi geçersiz'); return; }
    var player = document.getElementById('player');
    if (!player) return;
    var old = player.querySelector('video,iframe');
    var time = old && old.tagName === 'VIDEO' ? old.currentTime : 0;
    var wasPlaying = old && old.tagName === 'VIDEO' && !old.paused;
    if (old) player.removeChild(old);
    seekTarget = null;
    clearTimeout(seekCommitTimer);
    hideSeekPreview();
    var video = el('video');
    video.preload = 'auto';
    video.autoplay = true;
    video.src = url;
    var loadTimer = setTimeout(function () {
        if (video.parentNode && video.readyState < 1) sourceFailed(source, (source && source.name || 'Kaynak') + ' zamanında açılmadı');
    }, 25000);
    video.addEventListener('loadedmetadata', function () {
        clearTimeout(loadTimer);
        var targetTime = time || state.resumeTime || 0;
        if (targetTime > 0 && isFinite(video.duration)) video.currentTime = Math.min(targetTime, video.duration - 1);
        state.resumeTime = 0;
        if (wasPlaying || !time) video.play();
    });
    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('durationchange', updateProgress);
    video.addEventListener('play', updateProgress);
    video.addEventListener('pause', function () { saveProgress(true); });
    video.addEventListener('pause', updateProgress);
    video.addEventListener('ended', function () { saveProgress(true); episodeEnded(); });
    video.addEventListener('error', function () {
        clearTimeout(loadTimer);
        if (!video.parentNode) return;
        sourceFailed(source, (source && source.name || 'Kaynak') + ' oynatılamadı');
        showControls();
    });
    player.insertBefore(video, player.firstChild);
    state.quality = label;
    video.play();
    var seekBar = player.querySelector('.seek-bar');
    if (seekBar) seekBar.focus();
    showControls();
}

function updateProgress() {
    var video = document.querySelector('#player video');
    var bar = document.querySelector('#player .seek-bar span');
    var time = document.querySelector('#player .time');
    if (!video || !bar || !time) return;
    var displayedTime = seekTarget === null ? video.currentTime : seekTarget;
    bar.style.width = (isFinite(video.duration) && video.duration > 0 ? displayedTime / video.duration * 100 : 0) + '%';
    time.textContent = formatTime(displayedTime) + ' / ' + formatTime(video.duration);
    var play = document.querySelector('#player .play-button');
    if (play) play.textContent = video.paused ? 'Oynat' : 'Duraklat';
    var intro = isFinite(video.duration) && video.duration > 600 && video.currentTime < 300;
    var skip = document.querySelector('#player .skip-intro');
    if (skip) {
        if (!intro && document.activeElement === skip) { var seekBar = document.querySelector('#player .seek-bar'); if (seekBar) seekBar.focus(); }
        skip.style.display = intro ? '' : 'none';
    }
    var hint = document.querySelector('#player .skip-hint');
    if (hint) hint.className = intro && video.currentTime > 3 ? 'skip-hint visible' : 'skip-hint';
    saveProgress(false);
}

function hideSeekPreview() {
    clearTimeout(seekPreviewTimer);
    var preview = document.querySelector('#player .seek-preview');
    if (preview) preview.className = 'seek-preview';
}

function parsePreviewTime(value) {
    var parts = value.replace(',', '.').split(':');
    var seconds = 0;
    for (var i = 0; i < parts.length; i++) seconds = seconds * 60 + Number(parts[i]);
    return seconds;
}

function parsePreviewCues(text, base) {
    var lines = text.split(/\r?\n/);
    var cues = [];
    for (var i = 0; i < lines.length - 1; i++) {
        var match = lines[i].match(/^(\d{2}:\d{2}(?::\d{2})?[.,]\d+)\s+-->\s+(\d{2}:\d{2}(?::\d{2})?[.,]\d+)/);
        if (!match) continue;
        var value = (lines[i + 1] || '').trim();
        var coords = value.match(/#xywh=(\d+),(\d+),(\d+),(\d+)$/);
        if (coords) value = value.slice(0, coords.index);
        var link = document.createElement('a');
        link.href = base;
        link.href = new URL(value, link.href).href;
        if (!/^https:\/\//i.test(link.href)) continue;
        cues.push({ start: parsePreviewTime(match[1]), end: parsePreviewTime(match[2]), url: link.href, x: coords ? Number(coords[1]) : 0, y: coords ? Number(coords[2]) : 0, width: coords ? Number(coords[3]) : 0, height: coords ? Number(coords[4]) : 0 });
    }
    return cues;
}

function loadPreviewCues(id, source) {
    var url = 'https://tau-video.xyz/preview/' + encodeURIComponent(id);
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = 10000;
    xhr.onload = function () {
        if (state.view === 'player' && state.source === source && xhr.status === 200) previewCues = parsePreviewCues(xhr.responseText, url);
    };
    xhr.send();
}

function showSeekPreview(video, position) {
    var player = document.getElementById('player');
    var preview = player && player.querySelector('.seek-preview');
    var bar = player && player.querySelector('.seek-bar');
    if (!preview || !bar) return;
    var image = preview.querySelector('img');
    var cue = null;
    for (var i = 0; i < previewCues.length; i++) if (position >= previewCues[i].start && position < previewCues[i].end) { cue = previewCues[i]; break; }
    preview.className = cue ? 'seek-preview visible' : 'seek-preview visible no-image';
    if (cue) {
        image.style.display = 'block';
        image.onload = function () {
            if (!cue.width || !cue.height) { image.style.left = '0'; image.style.top = '0'; image.style.width = '100%'; image.style.height = '178px'; return; }
            var scale = 320 / cue.width;
            image.style.width = image.naturalWidth * scale + 'px';
            image.style.height = image.naturalHeight * scale + 'px';
            image.style.left = -cue.x * scale + 'px';
            image.style.top = -cue.y * scale + 'px';
        };
        image.onerror = function () { image.style.display = 'none'; preview.className = 'seek-preview visible no-image'; };
        if (image.src !== cue.url) image.src = cue.url;
        else if (image.complete) image.onload();
    } else image.style.display = 'none';
    preview.querySelector('.seek-preview-time').textContent = formatTime(position);
    var rect = bar.getBoundingClientRect();
    var playerRect = player.getBoundingClientRect();
    var left = rect.left - playerRect.left + rect.width * position / video.duration - preview.offsetWidth / 2;
    preview.style.left = Math.max(16, Math.min(playerRect.width - preview.offsetWidth - 16, left)) + 'px';
    clearTimeout(seekPreviewTimer);
    seekPreviewTimer = setTimeout(hideSeekPreview, 3000);
    showControls();
}

function seekTo(video, time) {
    if (!video || !isFinite(video.duration) || video.duration <= 0) return;
    seekTarget = Math.max(0, Math.min(Math.max(0, video.duration - 0.5), time));
    updateProgress();
    showSeekPreview(video, seekTarget);
    clearTimeout(seekCommitTimer);
    seekCommitTimer = setTimeout(commitSeek, 500);
    var bar = document.querySelector('#player .seek-bar');
    if (bar) bar.focus();
}

function seekBy(video, seconds) {
    seekTo(video, (seekTarget === null ? video.currentTime : seekTarget) + seconds);
}

function commitSeek() {
    clearTimeout(seekCommitTimer);
    var video = document.querySelector('#player video');
    if (video && seekTarget !== null) video.currentTime = seekTarget;
    seekTarget = null;
    updateProgress();
}

function togglePlayback() {
    var video = document.querySelector('#player video');
    if (!video) return;
    if (video.paused) video.play(); else video.pause();
    showControls();
}

function showChoice(items, selected, action) {
    var player = document.getElementById('player');
    if (!player) return;
    var old = player.querySelector('.choice');
    if (old) player.removeChild(old);
    var choice = el('div', 'choice');
    for (var i = 0; i < items.length; i++) {
        (function (item) {
            var node = button(item.label, item.value === selected ? 'active' : '', function () {
                player.removeChild(choice);
                action(item.value);
            });
            choice.appendChild(node);
        })(items[i]);
    }
    player.appendChild(choice);
    if (choice.firstChild) choice.firstChild.focus();
    showControls();
}

function showSources() {
    if (!state.sources.length) return;
    var items = [];
    for (var i = 0; i < state.sources.length; i++) items.push({ label: state.sources[i].name || 'Video', value: state.sources[i] });
    showChoice(items, state.source, selectSource);
}

function showQualities() {
    if (!state.videoData || !state.videoData.urls) { notify('Kalite seçeneği yok'); return; }
    var urls = state.videoData.urls;
    var items = [];
    for (var i = 0; i < urls.length; i++) items.push({ label: urls[i].label, value: urls[i] });
    showChoice(items, null, function (item) { playUrl(item.url, item.label); });
}

function showControls() {
    var player = document.getElementById('player');
    if (!player) return;
    player.className = 'player';
    clearTimeout(playerTimer);
    playerTimer = setTimeout(function () {
        if (state.view === 'player' && !player.querySelector('.choice')) player.className = 'player player-controls-hidden';
    }, 6500);
}

function closePlayer() {
    requestToken++;
    seekTarget = null;
    previewCues = [];
    clearTimeout(seekCommitTimer);
    hideSeekPreview();
    clearTimeout(playerTimer);
    clearNext();
    var video = document.querySelector('#player video');
    if (video) { saveProgress(true); video.pause(); }
    document.getElementById('app').className = '';
    document.getElementById('topbar').style.display = 'flex';
    state.view = 'detail';
    state.detailError = null;
    if (!state.episodes.length) {
        loadSeason(state.season);
    } else {
        renderDetail();
        var first = content.querySelector('.episode.resume') || content.querySelector('.episode');
        if (first) { first.focus(); first.scrollIntoView(false); }
    }
}

function back() {
    if (state.view === 'player') {
        var choice = document.querySelector('#player .choice');
        if (choice) { choice.parentNode.removeChild(choice); showControls(); return; }
        if (document.querySelector('#player .next-overlay')) { clearNext(); showControls(); var bar = document.querySelector('#player .seek-bar'); if (bar) bar.focus(); return; }
        closePlayer();
    } else if (state.view === 'detail' || state.view === 'search' || state.view === 'login' || state.view === 'switch' || state.view === 'register') {
        showHome();
        document.getElementById('brand').focus();
    } else if (window.tizen && tizen.application) {
        tizen.application.getCurrentApplication().exit();
    }
}

function moveFocus(direction) {
    var current = document.activeElement;
    if (!current || !current.classList || !current.classList.contains('focusable')) {
        var start = state.view === 'player' ? content.querySelector('.player button') : document.getElementById('brand');
        if (start) start.focus();
        return;
    }
    var currentRect = current && current.getBoundingClientRect ? current.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0 };
    var x = (currentRect.left + currentRect.right) / 2;
    var y = (currentRect.top + currentRect.bottom) / 2;
    var horizontal = direction === 'left' || direction === 'right';
    var group = horizontal && current.closest ? current.closest('#topbar, .cards, .season-bar, .error-actions, .next-actions, .history-list, .episode-list, .player-top, .player-bottom, .choice') : null;
    var nodes = group ? group.querySelectorAll('.focusable') : document.querySelectorAll('.focusable');
    var best = null;
    var bestScore = Infinity;
    var aligned = null;
    var alignedScore = Infinity;
    for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (node === current || node.offsetWidth === 0 || node.offsetHeight === 0) continue;
        var rect = node.getBoundingClientRect();
        var dx = (rect.left + rect.right) / 2 - x;
        var dy = (rect.top + rect.bottom) / 2 - y;
        if (direction === 'left' && dx >= -8) continue;
        if (direction === 'right' && dx <= 8) continue;
        if (direction === 'up' && dy >= -8) continue;
        if (direction === 'down' && dy <= 8) continue;
        var primary = horizontal ? Math.abs(dx) : Math.abs(dy);
        var secondary = horizontal ? Math.abs(dy) : Math.abs(dx);
        var score = primary + secondary * 2.5;
        if (score < bestScore) { best = node; bestScore = score; }
        var overlap = horizontal ? rect.bottom > currentRect.top + 4 && rect.top < currentRect.bottom - 4 : rect.right > currentRect.left + 4 && rect.left < currentRect.right - 4;
        if (overlap && score < alignedScore) { aligned = node; alignedScore = score; }
    }
    if (aligned) best = aligned;
    if (best) { best.focus(); best.scrollIntoView(false); }
}

document.getElementById('brand').addEventListener('click', showHome);
document.getElementById('searchButton').addEventListener('click', openSearch);
document.getElementById('accountButton').addEventListener('click', accountAction);
document.getElementById('registerButton').addEventListener('click', function () { accountView('register'); });
document.addEventListener('keydown', function (event) {
    var key = event.key || '';
    var code = event.keyCode;
    if (code === 10009 || key === 'Backspace' && document.activeElement.tagName !== 'INPUT' || key === 'Escape') { event.preventDefault(); back(); return; }
    var color = code === 403 || key === 'ColorF0Red' ? 'red' : code === 404 || key === 'ColorF1Green' ? 'green' : code === 405 || key === 'ColorF2Yellow' ? 'yellow' : code === 406 || key === 'ColorF3Blue' ? 'blue' : '';
    if (color) { event.preventDefault(); colorKey(color); return; }
    if (state.view === 'player') {
        showControls();
        var choice = document.querySelector('#player .choice, #player .player-error, #player .next-overlay');
        var video = choice ? null : document.querySelector('#player video');
        if (code === 10252 || code === 415 || code === 19 || key === 'MediaPlayPause') { event.preventDefault(); togglePlayback(); return; }
        if (code === 413 || key === 'MediaStop') { event.preventDefault(); closePlayer(); return; }
        if (!choice && video && (code === 412 || key === 'MediaRewind')) { event.preventDefault(); seekBy(video, -10); return; }
        if (!choice && video && (code === 417 || key === 'MediaFastForward')) { event.preventDefault(); seekBy(video, 10); return; }
        if (!choice && video && !document.activeElement.closest('.player-top') && (key === 'ArrowLeft' || code === 37)) { event.preventDefault(); seekBy(video, -10); return; }
        if (!choice && video && !document.activeElement.closest('.player-top') && (key === 'ArrowRight' || code === 39)) { event.preventDefault(); seekBy(video, 10); return; }
        if (!choice && (key === 'Enter' || code === 13) && document.activeElement.tagName !== 'BUTTON') { event.preventDefault(); togglePlayback(); return; }
    }
    if (document.activeElement.tagName === 'INPUT') {
        if (state.view === 'search' && (key === 'ArrowDown' || code === 40)) {
            event.preventDefault();
            var firstResult = content.querySelector('.search-page .card, .search-page .history-item, .search-page .error-box button');
            if (firstResult) { firstResult.focus(); firstResult.scrollIntoView(false); }
            else searchMovePending = true;
        }
        else if ((state.view === 'login' || state.view === 'switch' || state.view === 'register') && (key === 'ArrowDown' || code === 40 || key === 'ArrowUp' || code === 38)) { event.preventDefault(); moveFocus(key === 'ArrowUp' || code === 38 ? 'up' : 'down'); }
        return;
    }
    if (key === 'ArrowLeft' || code === 37) { event.preventDefault(); moveFocus('left'); }
    else if (key === 'ArrowRight' || code === 39) { event.preventDefault(); moveFocus('right'); }
    else if (key === 'ArrowUp' || code === 38) { event.preventDefault(); moveFocus('up'); }
    else if (key === 'ArrowDown' || code === 40) { event.preventDefault(); moveFocus('down'); }
    else if (key === 'Enter' || code === 13) { if (document.activeElement && document.activeElement.click) { event.preventDefault(); document.activeElement.click(); } }
});

function colorKey(color) {
    if (state.view === 'player') {
        if (color === 'red') showSources();
        else if (color === 'green') showQualities();
        else if (color === 'yellow') skipIntro();
        else playNext();
        return;
    }
    if (color === 'red') openSearch();
    else if (color === 'green') {
        var latest = readProgress()[0];
        if (latest) resumeEpisode(latest); else notify('Devam edilecek bölüm yok');
    } else if (color === 'yellow') accountAction();
    else { showHome(); document.getElementById('brand').focus(); }
}

try {
    if (window.tizen && tizen.tvinputdevice) tizen.tvinputdevice.registerKeyBatch(['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward']);
} catch (error) {}
try {
    if (window.tizen && tizen.tvinputdevice) tizen.tvinputdevice.registerKeyBatch(['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue']);
} catch (error) {}

document.addEventListener('visibilitychange', function () { if (document.hidden) saveProgress(true); });
window.addEventListener('pagehide', function () { saveProgress(true); });

showHome();
refreshAccount();
