// Build-time BC7 encoder for the Stage 5 asset script.
//
//   bc7tool <in.rgba> <out_prefix> <lambda>[,<lambda>...] [effort]
//
// <in.rgba> is: u32 LE width, u32 LE height, then width*height*4 RGBA8 bytes (sRGB color).
// For every lambda it writes <out_prefix>.l<lambda>.ktx2 (BC7 + full mip chain, KTX2, no supercompression)
// and prints one JSON line with the size and the PSNR of the decoded base level against the source.
// lambda 0 means plain BC7 (no RDO). Lambda > 0 is mipple's rate-distortion optimization.
// It also writes <out_prefix>.rgba8 : the uncompressed fallback (u32 w, u32 h, u32 levels, then every
// level's RGBA8 bytes, box-filtered mips) that the game uses only without texture-compression-bc.
use mipple::ktx2::{self, PrepMode};
use mipple::metrics::psnr;
use mipple::pipeline::{decode_level, encode, EncodeOptions};
use mipple::{Format, RdoParams, Surface};
use std::fs;
use std::time::Instant;

fn box_down(s: &Surface) -> Surface {
    let (w, h) = ((s.width / 2).max(1), (s.height / 2).max(1));
    let mut o = Surface::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0u32; 4];
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let p = s.get((x * 2 + dx).min(s.width - 1), (y * 2 + dy).min(s.height - 1));
                for c in 0..4 {
                    acc[c] += p[c] as u32;
                }
            }
            o.set(x, y, [((acc[0] + 2) / 4) as u8, ((acc[1] + 2) / 4) as u8, ((acc[2] + 2) / 4) as u8, ((acc[3] + 2) / 4) as u8]);
        }
    }
    o
}

fn main() {
    // Unoptimized builds of the encoder need a big stack.
    std::thread::Builder::new().stack_size(1 << 29).spawn(run).unwrap().join().unwrap();
}

fn run() {
    let a: Vec<String> = std::env::args().collect();
    let raw = fs::read(&a[1]).expect("read input");
    let w = u32::from_le_bytes(raw[0..4].try_into().unwrap());
    let h = u32::from_le_bytes(raw[4..8].try_into().unwrap());
    let mut src = Surface::new(w, h);
    for (i, p) in src.pixels.iter_mut().enumerate() {
        let o = 8 + i * 4;
        *p = [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]];
    }
    let prefix = &a[2];
    let effort: u8 = a.get(4).map(|s| s.parse().unwrap()).unwrap_or(5);

    // Uncompressed fallback.
    let mut fb = Vec::new();
    let mut levels = vec![src.clone()];
    while levels.last().unwrap().width > 1 || levels.last().unwrap().height > 1 {
        let n = box_down(levels.last().unwrap());
        levels.push(n);
    }
    fb.extend_from_slice(&w.to_le_bytes());
    fb.extend_from_slice(&h.to_le_bytes());
    fb.extend_from_slice(&(levels.len() as u32).to_le_bytes());
    for l in &levels {
        for p in &l.pixels {
            fb.extend_from_slice(p);
        }
    }
    fs::write(format!("{prefix}.rgba8"), &fb).unwrap();

    for ls in a[3].split(',') {
        let lambda: f32 = ls.parse().unwrap();
        let mut opts = EncodeOptions::new(Format::Bc7).with_role(mipple::Role::Albedo);
        opts.effort = effort;
        opts.mips = true;
        opts.gpu = mipple::GpuMode::Off;
        opts.rdo = RdoParams { lambda, ..RdoParams::default() };
        let t = Instant::now();
        let (tex, _rep) = encode(&src, &opts);
        let secs = t.elapsed().as_secs_f64();
        let bytes = ktx2::write(&tex, None, Some("vessel-stage5"), PrepMode::Off).unwrap();
        let out = format!("{prefix}.l{ls}.ktx2");
        fs::write(&out, &bytes).unwrap();
        let dec = decode_level(&tex, 0, false);
        let p_rgb = psnr(&src, &dec, &[0, 1, 2]);
        println!(
            "{{\"file\":\"{}\",\"lambda\":{},\"effort\":{},\"levels\":{},\"ktx2Bytes\":{},\"psnrRgbDb\":{:.3},\"encodeSecs\":{:.2}}}",
            out.replace('\\', "/"), lambda, effort, tex.levels.len(), bytes.len(), p_rgb, secs
        );
    }
}
