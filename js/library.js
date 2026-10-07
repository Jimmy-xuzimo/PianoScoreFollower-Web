/*
 * 乐谱库：导入过的乐谱要长期留在本地，关掉页面再回来还在。
 *
 * 手机上这些文件落在应用私有目录 + 一个文本索引；网页端对应的能力是 IndexedDB：
 * Blob 直接以结构化克隆存进去，页面刷新、浏览器重启都不会丢。
 * localStorage 只放“上次打开的是哪一份”这种小标记——它容量小，而且同步 API 不该碰大对象。
 */
(function (global) {
    'use strict';

    var DB_NAME = 'piano_follower_web';
    var DB_VERSION = 1;
    var STORE_NOTATION = 'notation';
    var STORE_SCROLL = 'scroll';
    var LAST_OPENED_KEY = 'piano_follower_last_opened';

    var dbPromise = null;

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            if (!global.indexedDB) {
                reject(new Error('当前浏览器不支持 IndexedDB，导入的乐谱将无法长期保存'));
                return;
            }
            var request = global.indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = function () {
                var db = request.result;
                if (!db.objectStoreNames.contains(STORE_NOTATION)) {
                    db.createObjectStore(STORE_NOTATION, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(STORE_SCROLL)) {
                    db.createObjectStore(STORE_SCROLL, { keyPath: 'id' });
                }
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () {
                reject(request.error || new Error('无法打开本地乐谱库'));
            };
        });
        return dbPromise;
    }

    function withStore(name, mode, action) {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var transaction = db.transaction(name, mode);
                var store = transaction.objectStore(name);
                var result;
                try {
                    result = action(store);
                } catch (error) {
                    reject(error);
                    return;
                }
                transaction.oncomplete = function () { resolve(result && result.value); };
                transaction.onerror = function () { reject(transaction.error); };
                transaction.onabort = function () { reject(transaction.error); };
            });
        });
    }

    function requestValue(request) {
        var box = { value: undefined };
        request.onsuccess = function () { box.value = request.result; };
        return box;
    }

    function makeId(prefix) {
        var random = Math.random().toString(36).slice(2, 8);
        return prefix + '-' + Date.now().toString(36) + '-' + random;
    }

    /* ------------------------------------------------------------------ */
    /* 记谱乐谱（MIDI / MusicXML / MXL）                                    */
    /* ------------------------------------------------------------------ */

    function putNotation(record) {
        var entry = {
            id: record.id || makeId('nt'),
            kind: 'notation',
            name: record.name,
            sourceFormat: record.sourceFormat,
            size: record.blob ? record.blob.size : 0,
            addedAt: Date.now(),
            blob: record.blob
        };
        return withStore(STORE_NOTATION, 'readwrite', function (store) {
            return requestValue(store.put(entry));
        }).then(function () { return entry; });
    }

    function listNotation() {
        return withStore(STORE_NOTATION, 'readonly', function (store) {
            return requestValue(store.getAll());
        }).then(function (rows) {
            return (rows || []).sort(function (a, b) { return b.addedAt - a.addedAt; });
        });
    }

    function getNotation(id) {
        return withStore(STORE_NOTATION, 'readonly', function (store) {
            return requestValue(store.get(id));
        });
    }

    function deleteNotation(id) {
        return withStore(STORE_NOTATION, 'readwrite', function (store) {
            return requestValue(store.delete(id));
        });
    }

    /* ------------------------------------------------------------------ */
    /* 滚动谱（PDF 光栅化后的逐页图片 / 相册照片）                            */
    /* ------------------------------------------------------------------ */

    function putScroll(record) {
        var entry = {
            id: record.id || makeId('sc'),
            kind: 'scroll',
            name: record.name,
            addedAt: Date.now(),
            durationSeconds: record.durationSeconds || 0,
            scrollRatio: record.scrollRatio || 0,
            pages: record.pages || []
        };
        return withStore(STORE_SCROLL, 'readwrite', function (store) {
            return requestValue(store.put(entry));
        }).then(function () { return entry; });
    }

    function listScroll() {
        return withStore(STORE_SCROLL, 'readonly', function (store) {
            return requestValue(store.getAll());
        }).then(function (rows) {
            return (rows || []).sort(function (a, b) { return b.addedAt - a.addedAt; });
        });
    }

    function getScroll(id) {
        return withStore(STORE_SCROLL, 'readonly', function (store) {
            return requestValue(store.get(id));
        });
    }

    /**
     * 局部更新。整份记录先读出来再写回，避免把 pages 数组丢掉——
     * 只有滚动位置、总时长这类小字段需要改，页图没必要重写一遍。
     */
    function updateScroll(id, patch) {
        return getScroll(id).then(function (entry) {
            if (!entry) return null;
            var merged = Object.assign({}, entry, patch, { id: id });
            return withStore(STORE_SCROLL, 'readwrite', function (store) {
                return requestValue(store.put(merged));
            }).then(function () { return merged; });
        });
    }

    function deleteScroll(id) {
        return withStore(STORE_SCROLL, 'readwrite', function (store) {
            return requestValue(store.delete(id));
        });
    }

    /* ------------------------------------------------------------------ */
    /* 上次打开的乐谱                                                       */
    /* ------------------------------------------------------------------ */

    function rememberLastOpened(kind, id) {
        try {
            global.localStorage.setItem(LAST_OPENED_KEY, JSON.stringify({ kind: kind, id: id }));
        } catch (e) {
            /* 隐私模式下忽略 */
        }
    }

    function lastOpened() {
        try {
            var raw = global.localStorage.getItem(LAST_OPENED_KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            return parsed && parsed.id ? parsed : null;
        } catch (e) {
            return null;
        }
    }

    function clearLastOpened() {
        try { global.localStorage.removeItem(LAST_OPENED_KEY); } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------------------------ */
    /* 统计与清理                                                           */
    /* ------------------------------------------------------------------ */

    function usage() {
        return Promise.all([listNotation(), listScroll()]).then(function (result) {
            var notation = result[0], scroll = result[1];
            var bytes = 0;
            notation.forEach(function (item) { bytes += item.size || 0; });
            var pageCount = 0;
            scroll.forEach(function (item) {
                pageCount += (item.pages || []).length;
                (item.pages || []).forEach(function (page) {
                    if (page && page.blob) bytes += page.blob.size || 0;
                });
            });
            return {
                notationCount: notation.length,
                scrollCount: scroll.length,
                pageCount: pageCount,
                bytes: bytes
            };
        });
    }

    global.PianoLibrary = {
        open: open,
        makeId: makeId,
        putNotation: putNotation,
        listNotation: listNotation,
        getNotation: getNotation,
        deleteNotation: deleteNotation,
        putScroll: putScroll,
        listScroll: listScroll,
        getScroll: getScroll,
        updateScroll: updateScroll,
        deleteScroll: deleteScroll,
        rememberLastOpened: rememberLastOpened,
        lastOpened: lastOpened,
        clearLastOpened: clearLastOpened,
        usage: usage
    };
})(window);
