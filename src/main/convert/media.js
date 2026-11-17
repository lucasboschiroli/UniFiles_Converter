// Video and audio conversions with ffmpeg.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runFfmpeg, probeDuration } = require('../tools');

const AUDIO_TARGETS = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac'];

const CRF = { high: { x264: 18, vp9: 28 }, balanced: { x264: 23, vp9: 33 }, small: { x264: 28, vp9: 38 } };

function audioArgs(target, bitrate) {
    const b = `${bitrate || 192}k`;
    switch (target) {
        case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', b];
        case 'm4a':
        case 'aac': return ['-c:a', 'aac', '-b:a', b];
        case 'wav': return ['-c:a', 'pcm_s16le'];
        case 'flac': return ['-c:a', 'flac'];
        case 'ogg': return ['-c:a', 'libvorbis', '-q:a', bitrate >= 256 ? '8' : bitrate >= 192 ? '6' : '4'];
        case 'opus': return ['-c:a', 'libopus', '-b:a', `${Math.min(bitrate || 192, 256)}k`];
        default: throw new Error(`Can't convert audio to ${target.toUpperCase()}`);
    }
}

// Scale down to the chosen height (never up), keeping even dimensions.
const scaleFilter = (height) => (height ? [`scale=-2:'min(${height},ih)'`] : []);

function videoArgs(target, opts) {
    const q = CRF[opts.videoQuality] || CRF.balanced;
    const vf = scaleFilter(opts.resolution);
    const filters = vf.length ? ['-vf', vf.join(',')] : [];
    const h264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(q.x264), '-pix_fmt', 'yuv420p', ...filters];
    switch (target) {
        case 'mp4':
        case 'mov': return [...h264, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
        case 'mkv': return [...h264, '-c:a', 'aac', '-b:a', '192k'];
        case 'webm': return ['-c:v', 'libvpx-vp9', '-crf', String(q.vp9), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', ...filters, '-c:a', 'libopus', '-b:a', '128k'];
        case 'avi': return ['-c:v', 'mpeg4', '-q:v', opts.videoQuality === 'high' ? '2' : opts.videoQuality === 'small' ? '6' : '4', ...filters, '-c:a', 'libmp3lame', '-b:a', '192k'];
        default: throw new Error(`Can't convert videos to ${target.toUpperCase()}`);
    }
}

async function convertMedia(src, target, out, opts, onProgress) {
    const duration = probeDuration(src);

    if (AUDIO_TARGETS.includes(target)) {
        // From audio or video: drop any video/cover streams, keep tags.
        return runFfmpeg(['-i', src, '-vn', '-map_metadata', '0', ...audioArgs(target, opts.audioBitrate), out], { duration, onProgress });
    }

    if (target === 'gif') {
        // Two-step palette for a GIF that doesn't look washed out.
        const width = Math.min(opts.resolution ? Math.round(opts.resolution * 16 / 9) : 640, 640);
        const fps = 12;
        const filter = `fps=${fps},scale='min(${width},iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
        return runFfmpeg(['-i', src, '-filter_complex', filter, '-loop', '0', out], { duration, onProgress });
    }

    return runFfmpeg(['-i', src, '-map', '0:v:0', '-map', '0:a?', ...videoArgs(target, opts), out], { duration, onProgress });
}

async function videoThumb(src) {
    const tmp = path.join(os.tmpdir(), `unifiles-thumb-${process.pid}-${Date.now()}.jpg`);
    try {
        const duration = probeDuration(src);
        const at = duration > 4 ? Math.min(duration * 0.1, 30) : 0;
        await runFfmpeg(['-ss', String(at), '-i', src, '-frames:v', '1', '-vf', 'scale=160:120:force_original_aspect_ratio=increase,crop=160:120', tmp], { track: false });
        return `data:image/jpeg;base64,${fs.readFileSync(tmp).toString('base64')}`;
    } catch {
        return null;
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

module.exports = { convertMedia, videoThumb };
