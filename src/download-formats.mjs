const validFormats = new Set(['mp3', 'wav', 'both']);

export function normalizeDownloadFormat(value) {
  const format = String(value).toLowerCase();
  if (!validFormats.has(format)) {
    throw new Error('--format 뒤에는 mp3, wav 또는 both를 입력하세요.');
  }
  return format;
}

export function shouldDownloadFormat(selectedFormat, audioFormat) {
  return selectedFormat === 'both' || selectedFormat === audioFormat;
}

export function downloadFormatLabel(format) {
  if (format === 'mp3') return 'MP3만';
  if (format === 'wav') return 'WAV만';
  return 'MP3 + WAV';
}
