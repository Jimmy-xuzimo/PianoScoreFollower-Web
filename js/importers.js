/*
 * 导入：把用户选中的文件变成乐谱库里的一条记录。
 *
 * 与手机端同一套判定——先看文件头再看扩展名：
 *   MIDI / MusicXML / MXL  → 记谱乐谱，交给 alphaTab 渲染
 *   PDF                    → 逐页光栅化成 JPEG，进滚动谱
 *   图片                   → 直接进滚动谱，过大的先降采样
 * 之所以 PDF 要光栅化而不是留着矢量渲染，是因为滚动谱要的是“总时长匀速滚动”，
 * 逐页位图的高度是确定的，滚动距离算得准，也不会在滚动中重新排版。
 */
(function (global) {
    'use strict';

    var PDFJS_BASE = 'assets/pdfjs/';
    var TARGET_PAGE_WIDTH = 1500;
    var MAX_PAGE_SCALE = 3;
    var MAX_IMAGE_DIMENSION = 2400;
    var JPEG_QUALITY = 0.88;

    var PDF_EXTENSIONS = ['.pdf'];
    var IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.heic', '.heif'];

    var pdfjsLoaded = null;

    function loadPdfJs() {
        if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
        if (pdfjsLoaded) return pdfjsLoaded;
        pdfjsLoaded = new Promise(function (resolve, reject) {
            var script = global.document.createElement('script');
            script.src = PDFJS_BASE + 'pdf.min.js';
            script.onload = function () {
                if (!global.pdfjsLib) {
                    reject(new Error('pdf.js 加载完成但未注册全局对象'));
                    return;
                }
                global.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
                resolve(global.pdfjsLib);
            };
            script.onerror = function () { reject(new Error('pdf.js 资源加载失败')); };
            global.document.head.appendChild(script);
        });
        return pdfjsLoaded;
    }

    function extensionOf(name) {
        var lower = (name || '').toLowerCase();
        var dot = lower.lastIndexOf('.');
        return dot < 0 ? '' : lower.slice(dot);
    }

    function isPdf(file) {
        return PDF_EXTENSIONS.indexOf(extensionOf(file.name)) >= 0;
    }

    function isImage(file) {
        if (IMAGE_EXTENSIONS.indexOf(extensionOf(file.name)) >= 0) return true;
        return !!(file.type && file.type.indexOf('image/') === 0);
    }

    function isScoreFile(file) {
        return !isPdf(file) && !isImage(file);
    }

    /* ------------------------------------------------------------------ */
    /* 记谱乐谱                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * 读取并规范化一个 MIDI / MusicXML 文件。
     * 返回 { name, sourceFormat, renderFormat, bytes, blob }，可直接落库。
     */
    function readNotationFile(file) {
        return file.arrayBuffer().then(function (buffer) {
            var bytes = new Uint8Array(buffer);
            var format = global.PianoMidi.detectFormat(bytes, file.name);
            if (format === global.PianoMidi.ScoreFormat.UNKNOWN) {
                throw new Error('无法识别「' + file.name + '」的格式，请提供 MIDI、MusicXML 或 MXL 文件');
            }

            var prepared;
            try {
                prepared = global.PianoMidi.prepare(file.name, format, bytes);
            } catch (error) {
                if (error && error.name === 'MidiConversionException') {
                    throw new Error('MIDI 解析失败：' + error.message);
                }
                throw error;
            }

            var payload = prepared.bytes;
            var blob = new Blob([payload], {
                type: prepared.renderFormat === global.PianoMidi.ScoreFormat.MUSIC_XML
                    ? 'application/vnd.recordare.musicxml+xml'
                    : 'application/octet-stream'
            });

            return {
                name: stripExtension(file.name),
                sourceFormat: prepared.sourceFormat,
                renderFormat: prepared.renderFormat,
                size: blob.size,
                bytes: payload,
                blob: blob
            };
        });
    }

    function stripExtension(name) {
        var dot = (name || '').lastIndexOf('.');
        return dot > 0 ? name.slice(0, dot) : (name || '未命名乐谱');
    }

    /* ------------------------------------------------------------------ */
    /* PDF 逐页光栅化                                                        */
    /* ------------------------------------------------------------------ */

    function rasterizePdf(file, onProgress) {
        return loadPdfJs().then(function (pdfjsLib) {
            return file.arrayBuffer().then(function (buffer) {
                return pdfjsLib.getDocument({
                    data: new Uint8Array(buffer),
                    /* 谱面是纯矢量线条，字体不必走外部资源，避免离线时卡住。 */
                    disableFontFace: false,
                    isEvalSupported: false
                }).promise;
            }).then(function (document) {
                var pages = [];
                var chain = Promise.resolve();

                for (var index = 1; index <= document.numPages; index++) {
                    (function (pageNumber) {
                        chain = chain.then(function () {
                            return renderPdfPage(document, pageNumber).then(function (page) {
                                pages.push(page);
                                if (onProgress) {
                                    onProgress(pageNumber, document.numPages);
                                }
                            });
                        });
                    })(index);
                }

                return chain.then(function () {
                    document.destroy();
                    return pages;
                });
            });
        });
    }

    function renderPdfPage(document, pageNumber) {
        return document.getPage(pageNumber).then(function (page) {
            var base = page.getViewport({ scale: 1 });
            var scale = Math.min(TARGET_PAGE_WIDTH / base.width, MAX_PAGE_SCALE);
            var viewport = page.getViewport({ scale: scale });

            var canvas = global.document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(viewport.width));
            canvas.height = Math.max(1, Math.round(viewport.height));
            var context = canvas.getContext('2d');
            context.fillStyle = '#FFFFFF';
            context.fillRect(0, 0, canvas.width, canvas.height);

            return page.render({ canvasContext: context, viewport: viewport }).promise.then(function () {
                return canvasToBlob(canvas).then(function (blob) {
                    return { blob: blob, width: canvas.width, height: canvas.height };
                });
            });
        });
    }

    /* ------------------------------------------------------------------ */
    /* 图片                                                                 */
    /* ------------------------------------------------------------------ */

    function readImageFile(file) {
        return decodeImage(file).then(function (bitmap) {
            var scale = 1;
            var longest = Math.max(bitmap.width, bitmap.height);
            if (longest > MAX_IMAGE_DIMENSION) {
                scale = MAX_IMAGE_DIMENSION / longest;
            }

            var width = Math.max(1, Math.round(bitmap.width * scale));
            var height = Math.max(1, Math.round(bitmap.height * scale));
            var canvas = global.document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            var context = canvas.getContext('2d');
            /* 谱面是白底黑线，透明区域补白，转 JPEG 后不会变成黑块。 */
            context.fillStyle = '#FFFFFF';
            context.fillRect(0, 0, width, height);
            context.drawImage(bitmap, 0, 0, width, height);
            if (bitmap.close) bitmap.close();

            return canvasToBlob(canvas).then(function (blob) {
                return { blob: blob, width: width, height: height };
            });
        });
    }

    function decodeImage(file) {
        if (global.createImageBitmap) {
            return global.createImageBitmap(file, { imageOrientation: 'from-image' })
                .catch(function () { return decodeViaElement(file); });
        }
        return decodeViaElement(file);
    }

    function decodeViaElement(file) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file);
            var image = new Image();
            image.onload = function () {
                URL.revokeObjectURL(url);
                resolve(image);
            };
            image.onerror = function () {
                URL.revokeObjectURL(url);
                reject(new Error('无法解码图片：' + file.name));
            };
            image.src = url;
        });
    }

    function canvasToBlob(canvas) {
        return new Promise(function (resolve, reject) {
            canvas.toBlob(function (blob) {
                if (blob) resolve(blob);
                else reject(new Error('图片编码失败'));
            }, 'image/jpeg', JPEG_QUALITY);
        });
    }

    /* ------------------------------------------------------------------ */
    /* 高层入口                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * 一批文件 → 一条滚动谱记录。
     * PDF 按页展开，图片按选择顺序排在后面；同名多文件按文件名自然排序，
     * 这样「第 1 页.jpg、第 2 页.jpg …」多选进来顺序就是对的。
     */
    function importScrollFiles(files, onProgress) {
        var list = Array.prototype.slice.call(files);
        if (list.length === 0) return Promise.reject(new Error('没有选择任何文件'));

        var pdfs = list.filter(isPdf);
        var images = list.filter(isImage).sort(compareNatural);

        var pages = [];
        var name = stripExtension(list[0].name);

        var chain = Promise.resolve();
        pdfs.forEach(function (file) {
            chain = chain.then(function () {
                return rasterizePdf(file, function (done, total) {
                    if (onProgress) onProgress('正在解析 ' + file.name + '（' + done + '/' + total + '）');
                }).then(function (rendered) {
                    pages = pages.concat(rendered);
                });
            });
        });

        chain = chain.then(function () {
            var index = 0;
            var sequential = images.reduce(function (acc, file) {
                return acc.then(function () {
                    index++;
                    if (onProgress) onProgress('正在处理图片（' + index + '/' + images.length + '）');
                    return readImageFile(file).then(function (page) { pages.push(page); });
                });
            }, Promise.resolve());
            return sequential;
        });

        return chain.then(function () {
            if (pages.length === 0) throw new Error('没有可用的谱页');
            return { name: name, pages: pages };
        });
    }

    function compareNatural(a, b) {
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    }

    global.PianoImport = {
        isPdf: isPdf,
        isImage: isImage,
        isScoreFile: isScoreFile,
        readNotationFile: readNotationFile,
        importScrollFiles: importScrollFiles,
        readImageFile: readImageFile,
        stripExtension: stripExtension
    };
})(window);
