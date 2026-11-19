// A lazily loaded code chunk. The build tag is baked in so each build's chunk has a different content hash.
declare const __BUILD_TAG__: string;
export function lazyHello(): string { return `lazy chunk from build ${__BUILD_TAG__}`; }
