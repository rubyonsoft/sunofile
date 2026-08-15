import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { shouldDownloadFormat } from './download-formats.mjs';

export function hasEnoughWorkspaceAudioFiles(songCount, downloadFormat, counts) {
  const requiredCount = Number(songCount);
  if (!Number.isInteger(requiredCount) || requiredCount < 1) return false;

  return (
    (!shouldDownloadFormat(downloadFormat, 'mp3') || counts.mp3 >= requiredCount)
    && (!shouldDownloadFormat(downloadFormat, 'wav') || counts.wav >= requiredCount)
  );
}

export async function evaluateWorkspaceAudioFiles(directory, songCount, downloadFormat) {
  const counts = { mp3: 0, wav: 0 };
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { skip: false, counts };
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLocaleLowerCase();
    if (extension === '.mp3') counts.mp3 += 1;
    if (extension === '.wav') counts.wav += 1;
  }

  return {
    skip: hasEnoughWorkspaceAudioFiles(songCount, downloadFormat, counts),
    counts,
  };
}
