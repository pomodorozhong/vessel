// Types for the AudioWorkletGlobalScope, which lib.dom does not declare.
declare const currentFrame: number;
declare const currentTime: number;
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: any);
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, processorCtor: new (options?: any) => AudioWorkletProcessor): void;
