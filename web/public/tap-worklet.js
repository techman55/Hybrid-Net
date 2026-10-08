// Downmixes the input to mono and posts it to the main thread in 1024-sample chunks.
class TapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const a = input[0];
      const b = input[1];
      for (let i = 0; i < a.length; i++) {
        this.buf[this.n++] = b ? 0.5 * (a[i] + b[i]) : a[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(1024);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("tap-processor", TapProcessor);
