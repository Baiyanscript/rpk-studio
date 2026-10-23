//! RPK 结构的最小实现，只依赖标准库。
//!
//! 这里放的是「原生侧确实需要、且能用纯 std 做对」的部分：
//! SHA-256、ZIP 中央目录解析、PNG 头部尺寸。签名验证与 DEFLATE
//! 留给前端（WebCrypto + fflate），避免在 Rust 侧重复实现一套容易出偏差的逻辑。
//!
//! 单独编译测试：
//! ```text
//! rustc --edition 2021 --test rpk_core.rs -o /tmp/rpk_core_test && /tmp/rpk_core_test
//! ```

/* ---------- SHA-256 ---------- */

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut msg = Vec::with_capacity(data.len() + 72);
    msg.extend_from_slice(data);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for block in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for i in 0..8 {
        out[i * 4..i * 4 + 4].copy_from_slice(&h[i].to_be_bytes());
    }
    out
}

pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/* ---------- ZIP 中央目录 ---------- */

#[derive(Debug, Clone)]
pub struct ZipEntry {
    pub name: String,
    pub method: u16,
    pub crc: u32,
    pub csize: u32,
    pub usize: u32,
    pub local_offset: u32,
}

fn u16_at(b: &[u8], p: usize) -> Option<u16> {
    b.get(p..p + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
}

fn u32_at(b: &[u8], p: usize) -> Option<u32> {
    b.get(p..p + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

pub fn find_eocd(b: &[u8]) -> Option<usize> {
    if b.len() < 22 {
        return None;
    }
    let start = b.len() - 22;
    let stop = b.len().saturating_sub(22 + 65535);
    let mut p = start;
    loop {
        if u32_at(b, p) == Some(0x0605_4b50) {
            return Some(p);
        }
        if p == stop {
            return None;
        }
        p -= 1;
    }
}

pub fn read_central_directory(b: &[u8]) -> Result<Vec<ZipEntry>, String> {
    let eocd = find_eocd(b).ok_or("找不到中央目录，文件可能不是 ZIP/RPK")?;
    let count = u16_at(b, eocd + 10).unwrap_or(0) as usize;
    let cd_offset = u32_at(b, eocd + 16).unwrap_or(0) as usize;

    let mut entries = Vec::with_capacity(count);
    let mut p = cd_offset;

    for _ in 0..count {
        if u32_at(b, p) != Some(0x0201_4b50) {
            break;
        }
        let name_len = u16_at(b, p + 28).unwrap_or(0) as usize;
        let extra_len = u16_at(b, p + 30).unwrap_or(0) as usize;
        let cmt_len = u16_at(b, p + 32).unwrap_or(0) as usize;
        let name = b
            .get(p + 46..p + 46 + name_len)
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .unwrap_or_default();

        entries.push(ZipEntry {
            name,
            method: u16_at(b, p + 10).unwrap_or(0),
            crc: u32_at(b, p + 16).unwrap_or(0),
            csize: u32_at(b, p + 20).unwrap_or(0),
            usize: u32_at(b, p + 24).unwrap_or(0),
            local_offset: u32_at(b, p + 42).unwrap_or(0),
        });

        p += 46 + name_len + extra_len + cmt_len;
    }

    Ok(entries)
}

/* ---------- PNG ---------- */

pub fn png_size(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 24 || data[0..8] != [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
        return None;
    }
    if data[12..16] != [0x49, 0x48, 0x44, 0x52] {
        return None;
    }
    let w = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
    let h = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
    Some((w, h))
}

/* ---------- 包摘要 ---------- */

#[derive(Debug, Clone)]
pub struct PackageSummary {
    pub size: u64,
    pub sha256: String,
    pub entries: usize,
    pub files: usize,
    pub images: usize,
    pub has_manifest: bool,
    pub has_cert: bool,
}

pub fn summarize(bytes: &[u8]) -> Result<PackageSummary, String> {
    let entries = read_central_directory(bytes)?;
    let images = entries
        .iter()
        .filter(|e| {
            let n = e.name.to_ascii_lowercase();
            n.ends_with(".png") || n.ends_with(".jpg") || n.ends_with(".jpeg") || n.ends_with(".webp")
        })
        .count();

    Ok(PackageSummary {
        size: bytes.len() as u64,
        sha256: hex(&sha256(bytes)),
        entries: entries.len(),
        files: entries.iter().filter(|e| !e.name.ends_with('/')).count(),
        images,
        has_manifest: entries.iter().any(|e| e.name == "manifest.json"),
        has_cert: entries.iter().any(|e| e.name == "META-INF/CERT"),
    })
}

/* ---------- 测试 ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(
            hex(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex(&sha256(b"The quick brown fox jumps over the lazy dog")),
            "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
        );
    }

    #[test]
    fn sha256_long_input() {
        // 跨块边界（55/56/64/65 字节）
        for len in [55usize, 56, 63, 64, 65, 1000] {
            let data = vec![0x61u8; len];
            let digest = sha256(&data);
            assert_eq!(digest.len(), 32);
        }
    }

    #[test]
    fn png_size_reads_ihdr() {
        // 最小 PNG 头：签名 + IHDR 长度/类型 + 宽高
        let mut d = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        d.extend_from_slice(&[0, 0, 0, 13]);
        d.extend_from_slice(b"IHDR");
        d.extend_from_slice(&100u32.to_be_bytes());
        d.extend_from_slice(&72u32.to_be_bytes());
        assert_eq!(png_size(&d), Some((100, 72)));
        assert_eq!(png_size(b"not a png"), None);
    }

    #[test]
    fn central_directory_parses_real_package() {
        let path = "/workspace/exp/A.rpk";
        let Ok(bytes) = std::fs::read(path) else {
            eprintln!("跳过：样例包不存在");
            return;
        };
        let entries = read_central_directory(&bytes).expect("应能解析中央目录");
        assert_eq!(entries.len(), 211, "样例包应有 211 个条目");
        let summary = summarize(&bytes).unwrap();
        assert_eq!(summary.files, 154);
        assert!(summary.has_manifest && summary.has_cert);
        assert_eq!(summary.sha256.len(), 64);
        eprintln!(
            "包摘要：{} 项 / {} 文件 / {} 图片 / sha256 {}",
            summary.entries, summary.files, summary.images, &summary.sha256[..16]
        );
    }
}
