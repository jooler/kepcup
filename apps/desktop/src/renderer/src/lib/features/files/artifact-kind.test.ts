import { describe, expect, it } from 'vitest';
import {
  artifactKindOf,
  extensionOf,
  formatFileSize,
  isAudioArtifact,
  isTextualKind,
} from './artifact-kind';

describe('artifact kinds', () => {
  it('maps extensions to the preview renderer', () => {
    expect(artifactKindOf('/a/b/screen.PNG')).toBe('image');
    expect(artifactKindOf('/a/b/demo.mp4')).toBe('video');
    expect(artifactKindOf('/a/b/page.html')).toBe('html');
    expect(artifactKindOf('/a/b/NOTES.md')).toBe('markdown');
    expect(artifactKindOf('/a/b/report.pdf')).toBe('pdf');
    expect(artifactKindOf('/a/b/report.docx')).toBe('document');
    expect(artifactKindOf('/a/b/sheet.xlsx')).toBe('spreadsheet');
    expect(artifactKindOf('/a/b/deck.pptx')).toBe('presentation');
    expect(artifactKindOf('/a/b/main.ts')).toBe('code');
    expect(artifactKindOf('/a/b/settings.JSON')).toBe('code');
    expect(artifactKindOf('/a/b/notes.txt')).toBe('text');
    expect(artifactKindOf('/a/b/server.log')).toBe('text');
    expect(artifactKindOf('/a/b/archive.zip')).toBe('other');
  });

  it('extracts the extension case-insensitively', () => {
    expect(extensionOf('/a/b.HTML')).toBe('.html');
    expect(extensionOf('no-extension')).toBe('');
  });

  it('keeps plain prose and logs out of the code renderer', () => {
    expect(artifactKindOf('/a/b/CHANGELOG.txt')).toBe('text');
    expect(artifactKindOf('/a/b/build.log')).toBe('text');
    expect(artifactKindOf('/a/b/Dockerfile')).toBe('other');
  });

  it('marks only document-like text as textual', () => {
    expect(isTextualKind('html')).toBe(true);
    expect(isTextualKind('markdown')).toBe(true);
    expect(isTextualKind('text')).toBe(true);
    expect(isTextualKind('code')).toBe(true);
    expect(isTextualKind('image')).toBe(false);
  });

  it('formats sizes', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2 MB');
    expect(formatFileSize(undefined)).toBe('');
  });
});

describe('isAudioArtifact（音频产物 → AudioPlayer 行，53 号修订 v2 V2-2）', () => {
  it('常见 TTS / 音频扩展名按音频处理', () => {
    expect(isAudioArtifact('/a/b/voice.mp3')).toBe(true);
    expect(isAudioArtifact('/a/b/voice.wav')).toBe(true);
    expect(isAudioArtifact('/a/b/voice.opus')).toBe(true);
    expect(isAudioArtifact('/a/b/voice.m4a')).toBe(true);
    expect(isAudioArtifact('/a/b/voice.aac')).toBe(true);
    expect(isAudioArtifact('/a/b/voice.flac')).toBe(true);
  });

  it('ogg / oga / weba 无视频分类冲突 → 音频', () => {
    expect(isAudioArtifact('/a/b/voice.ogg')).toBe(true);
    expect(isAudioArtifact('/a/b/voice.oga')).toBe(true);
    expect(isAudioArtifact('/a/b/voice.weba')).toBe(true);
  });

  it('已判为 video 的扩展名不按音频处理（.webm 音视频双栖，.ogv 纯视频）', () => {
    expect(artifactKindOf('/a/b/clip.webm')).toBe('video');
    expect(isAudioArtifact('/a/b/clip.webm')).toBe(false);
    expect(isAudioArtifact('/a/b/clip.ogv')).toBe(false);
  });

  it('扩展名大小写不敏感', () => {
    expect(isAudioArtifact('/a/b/VOICE.MP3')).toBe(true);
    expect(isAudioArtifact('/a/b/TAKE_01.WAV')).toBe(true);
    expect(isAudioArtifact('/a/b/CLIP.WEBM')).toBe(false);
  });

  it('非音频名字不误判：无扩展名 / 空名 / 其他类型', () => {
    expect(isAudioArtifact('/a/b/no-extension')).toBe(false);
    expect(isAudioArtifact('')).toBe(false);
    expect(isAudioArtifact('/a/b/')).toBe(false); // 名字为空（路径以分隔符结尾）
    expect(isAudioArtifact('/a/b/clip.mp4')).toBe(false);
    expect(isAudioArtifact('/a/b/page.html')).toBe(false);
    expect(isAudioArtifact('/a/b/archive.zip')).toBe(false);
  });

  it('点开头无主干名的隐藏文件不取扩展名（.mp3 不是音频）', () => {
    expect(extensionOf('/a/b/.mp3')).toBe('');
    expect(isAudioArtifact('/a/b/.mp3')).toBe(false);
  });
});
