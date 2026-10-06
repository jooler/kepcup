// AudioWorklet 采集处理器（docs/design/26-voice-input.md 的录音管道）。
// 以 Vite 静态资源加载（voice-recorder.ts 里 `?url` 导入）——不能用 blob: 内联：
// 渲染层 CSP 的 script-src 'self' 会拦掉 blob: 脚本，addModule 直接失败。
// 每次 process 回调拷贝一帧 32-bit PCM 投给主线程，同时带上 RMS 电平（波形动画用）。
class KepcupVoiceCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      let sum = 0;
      for (let i = 0; i < copy.length; i += 1) sum += copy[i] * copy[i];
      this.port.postMessage({ pcm: copy, level: Math.sqrt(sum / copy.length) }, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('kepcup-voice-capture', KepcupVoiceCapture);
