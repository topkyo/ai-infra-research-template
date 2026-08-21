export const SITE_NAME = "topkyo · AI 基建研究台";
export const SITE_TAGLINE = "个人 AI 基建主题 A 股研究仪表盘";
export const SITE_EYEBROW = "个人研究 · DeepSeek · A 股";
export const SITE_DESCRIPTION =
  "聚焦 AI 算力、互连、散热、电力、IDC、存储、半导体设备与材料的 A 股主题研究。";
export const SITE_HERO =
  "跟踪算力芯片、光模块、AI 服务器、液冷、电力、IDC、半导体材料与 AI-PCB 等 AI 基建供给侧标的。";
export const SITE_OWNER = "topkyo";
export const SITE_REPO = "ai-infra-research-template";
/** metadataBase for OG URLs. Override with NEXT_PUBLIC_SITE_URL; do not point at a maintainer Pages/Vercel host. */
export const SITE_PAGES_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000";
/** Optional public static snapshot URL. Set NEXT_PUBLIC_PUBLIC_SNAPSHOT_URL at build time. */
export const SITE_PUBLIC_SNAPSHOT_URL =
  process.env.NEXT_PUBLIC_PUBLIC_SNAPSHOT_URL?.trim() || "";
export const SITE_PRIVATE_NOTE = "个人研究项目，不构成投资建议";
export const SITE_SOCIAL_CARD_ALT = `${SITE_NAME} 社交分享卡片`;
