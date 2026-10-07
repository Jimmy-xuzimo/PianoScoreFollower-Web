/*
 * 采集 hop 的 AudioWorkletProcessor。
 *
 * AudioWorklet 的渲染量子是 128 帧，而分析窗要的是 1024 帧的整 hop，
 * 所以这里做纯搬运：攒满 HOP_SIZE 就把这一段 PCM 交给主线程，
 * 并带上 currentTime 作为音频时间戳——时间戳来自音频时钟而不是 Date.now()，
 * 因此即使主线程抖动，起音时刻也不会被记错。
 */
class PcmHopProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        var opts = (options && options.processorOptions) || {};
        this.hopSize = opts.hopSize || 1024;
        this.buffer = new Float32Array(this.hopSize);
        this.filled = 0;
    }

    process(inputs) {
        var input = inputs[0];
        if (!input || input.length === 0) return true;
        var channel = input[0];
        if (!channel || channel.length === 0) return true;

        for (var i = 0; i < channel.length; i++) {
            this.buffer[this.filled++] = channel[i];
            if (this.filled === this.hopSize) {
                var hop = new Float32Array(this.hopSize);
                hop.set(this.buffer);
                this.filled = 0;
                this.port.postMessage({ hop: hop, timeMs: currentTime * 1000 }, [hop.buffer]);
            }
        }
        return true;
    }
}

registerProcessor('pcm-hop', PcmHopProcessor);
