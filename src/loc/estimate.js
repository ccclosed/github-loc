// Оценка числа строк по байтам, которые отдаёт GitHub API (/languages).
import { bytesPerLine } from './lang.js';

/**
 * @param {Record<string, number>} languageBytes байты по языкам
 * @param {{bpl?: (name:string)=>number}} [opts]
 * @returns {{total:number, method:'estimate', perLanguage:Record<string,{lines:number,bytes:number,estimated:true}>}}
 */
export function estimateLines(languageBytes, { bpl } = {}) {
  const perLanguage = Object.create(null);
  let total = 0;
  const source = languageBytes && typeof languageBytes === 'object' ? languageBytes : {};
  for (const [name, rawBytes] of Object.entries(source)) {
    const bytes = Number(rawBytes) || 0;
    if (bytes <= 0) continue;
    const per = bpl ? bpl(name) : bytesPerLine(name);
    const lines = Math.max(1, Math.round(bytes / (per > 0 ? per : 30)));
    perLanguage[name] = { lines, bytes, estimated: true };
    total += lines;
  }
  return { total, method: 'estimate', perLanguage: { ...perLanguage } };
}