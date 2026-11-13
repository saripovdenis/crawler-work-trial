import { comparisonProviders } from "./comparison.js";
export const providerIds = ["google", "exa"] as const;
export type ProviderId = (typeof providerIds)[number];
export const pollInterval = 10 * 60_000;
// Each steady-state poll overlaps the previous successful poll by one hour.
export const pollLookback = 60 * 60_000;
export const editions: Record<
  string,
  { hl: string; gl: string; ceid: string }
> = {};
const edition = (domains: string[], hl: string, gl: string, language: string) =>
  domains.forEach((d) => (editions[d] = { hl, gl, ceid: `${gl}:${language}` }));
edition(["sina.com.cn", "eastmoney.com", "ce.cn"], "zh-CN", "CN", "zh-Hans");
edition(["zaobao.com.sg"], "zh-CN", "SG", "zh-Hans");
edition(["udn.com"], "zh-TW", "TW", "zh-Hant");
edition(["chosun.com"], "ko", "KR", "ko");
edition(["antaranews.com"], "id", "ID", "id");
edition(["hurriyet.com.tr", "haberturk.com"], "tr", "TR", "tr");
edition(["youm7.com"], "ar", "EG", "ar");
edition(["eldiario.es", "elmundo.es", "eleconomista.es"], "es", "ES", "es");
edition(["biobiochile.cl"], "es-419", "CL", "es-419");
edition(["cnnbrasil.com.br"], "pt-BR", "BR", "pt-419");
edition(["mediapart.fr"], "fr", "FR", "fr");
edition(["bbc.com"], "en-GB", "GB", "en");
edition(["hoodline.com"], "en-US", "US", "en");
edition(["indiatimes.com", "newindianexpress.com"], "en-IN", "IN", "en");
export function providerConfig(env: NodeJS.ProcessEnv = process.env) {
  const cap = (name: string, fallback: number) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${name}`);
    return n;
  };
  return providerIds.map((id) => ({
    id,
    key: id === "exa" ? env.EXA_API_KEY : undefined,
    daily: cap(
      `MONITOR_${id.toUpperCase()}_DAILY_LIMIT`,
      id === "google" ? 3000 : 1000,
    ),
    lifetime: cap(
      `MONITOR_${id.toUpperCase()}_TOTAL_LIMIT`,
      id === "exa" ? 1000 : 0,
    ),
    enabled: Object.hasOwn(comparisonProviders, id) && (id === "google" || !!env.EXA_API_KEY),
    scheduled: true,
  }));
}
