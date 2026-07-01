const configuredBase = import.meta.env?.BASE_URL ?? "./";
const assetBase = typeof document === "undefined"
  ? configuredBase
  : new URL(configuredBase, document.baseURI).href;

const portrait = (file, tone, accent) => ({
  accent,
  src: `${assetBase}assets/portraits/generated/${file}`,
  tone,
});

export const PORTRAITS = {
  "白石凛": portrait("rin.png", "冷静 / 观察者", "#c9d8e7"),
  "神谷悠真": portrait("yuma.png", "班长 / 自制", "#9bb7d6"),
  "藤泽葵": portrait("aoi.png", "青梅 / 激烈", "#d98088"),
  "久世透": portrait("tooru.png", "摄影社 / 沉默", "#a7afbc"),
  "黑田陆": portrait("riku.png", "问题学生 / 防御", "#c6685d"),
  "水野纱月": portrait("satsuki.png", "保健委员 / 克制", "#b9c7d2"),
  "御影司": portrait("tsukasa.png", "学生会 / 理性", "#91a9c6"),
  "相原澪": portrait("mio.png", "妹妹 / 封存", "#bda4c9"),
  "夏见遥的声音": portrait("haruka.png", "记忆残响", "#d3b2b6"),
  "未知女声": portrait("haruka.png", "记忆残响", "#d3b2b6"),
};

export function getPortrait(speaker) {
  return PORTRAITS[speaker] ?? null;
}
