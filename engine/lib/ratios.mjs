// Aspect-ratio knowledge base.
// Rule: never let Doubao fall back to its 1:1 default. Every prompt must carry an
// explicit ratio, and the ratio must be chosen from the intended USE, not from taste.
//
// Ratio values are verified against Doubao: the client honours an explicit
// "生成一张 <ratio> <orientation>图片" instruction and returns exactly that canvas.

export const RATIO_SIZES = {
  '1:1': [1, 1],
  '4:3': [4, 3],
  '3:4': [3, 4],
  '16:9': [16, 9],
  '9:16': [9, 16],
  '3:2': [3, 2],
  '2:3': [2, 3],
  '4:5': [4, 5],
  '5:4': [5, 4],
  '21:9': [21, 9],
  '2:1': [2, 1],
  '3:1': [3, 1],
  '4:1': [4, 1],
  '2.35:1': [47, 20],
  '1.414:1': [1414, 1000],
  '9:5': [9, 5],
};

export function orientation(ratio) {
  const [w, h] = RATIO_SIZES[ratio] || [1, 1];
  if (w === h) return '方形';
  if (w > h * 2.2) return '宽幅横向';
  if (w > h) return '横版';
  if (h > w * 2.2) return '竖长条';
  return '竖版';
}

export function pixelSize(ratio, longEdge) {
  const [w, h] = RATIO_SIZES[ratio] || [1, 1];
  const scale = longEdge / Math.max(w, h);
  const gcdRound = (v) => Math.round(v / 8) * 8;
  return [gcdRound(w * scale), gcdRound(h * scale)];
}

// longEdge = the pixel length of the longer side we ask Doubao for (≈2048 is its natural max)
export const CATEGORIES = [
  // ---- 游戏 / UI 素材 ----
  { id: 'ui-icon', label: 'UI 图标 / 道具图标 / 技能图标', ratio: '1:1',
    comp: '主体居中，四周留 8%-12% 留白，纯色背景便于抠图，正面视角' },
  { id: 'ui-button', label: '按钮 / 标题条 / 条幅', ratio: '3:1',
    comp: '按钮横向铺满画面宽度，上下留白极少，圆角与描边完整不被裁切' },
  { id: 'ui-panel', label: '面板 / 弹窗 / 卡片底图', ratio: '4:3',
    comp: '面板居中占画面 70%-80%，边缘完整，四周留白' },
  { id: 'game-portrait', label: '角色立绘 / 卡面', ratio: '3:4',
    comp: '角色全身或半身居中，头顶与脚底各留 5% 空间，不裁切' },
  { id: 'game-scene', label: '场景背景（横屏）', ratio: '16:9',
    comp: '横向展开的完整场景，主体偏中，底部留出 UI 占位' },
  { id: 'game-splash', label: '启动页 / 竖屏主界面', ratio: '9:16',
    comp: '竖版满屏构图，主体位于中上部，底部留出约 30% 空间放按钮' },
  { id: 'game-hero', label: '宣传主视觉 / 封面图', ratio: '16:9',
    comp: '主体居中偏左或居中，暗部统一，适合叠标题字' },

  // ---- 社交 / 内容 ----
  { id: 'social-square', label: '朋友圈 / Instagram 方图', ratio: '1:1',
    comp: '主体居中，四周留白均匀' },
  { id: 'social-portrait', label: 'Instagram 竖版 / 小红书', ratio: '4:5',
    comp: '主体居中，上下留白少' },
  { id: 'social-xiaohongshu', label: '小红书封面', ratio: '3:4',
    comp: '竖版构图，上半部放主体，下半部留白可加字' },
  { id: 'social-vertical', label: '抖音 / Reels / 故事', ratio: '9:16',
    comp: '竖屏满版，主体位于画面上三分之二，底部避开文字区' },
  { id: 'social-video', label: '视频封面 / B站 / YouTube', ratio: '16:9',
    comp: '横向满版，主体居中，左右留白可叠标题' },
  { id: 'social-wechat-cover', label: '公众号首图 / 文章头图', ratio: '2.35:1',
    comp: '超宽横幅，主体居中偏左，右侧留白放标题' },
  { id: 'avatar', label: '头像 / 个人资料图', ratio: '1:1',
    comp: '人物肩部以上特写，面部居中，四周留白均匀' },

  // ---- 电商 ----
  { id: 'ecom-main', label: '电商主图', ratio: '1:1',
    comp: '商品居中占画面 70%-80%，纯白或浅色背景，四周留白均匀' },
  { id: 'ecom-banner', label: '店铺横幅 / 活动 Banner', ratio: '3:1',
    comp: '横幅构图，主体居中偏右，左侧留白放文案' },
  { id: 'ecom-detail', label: '详情页长图', ratio: '9:16',
    comp: '竖向长构图，信息从上到下排布，避免上下裁切' },

  // ---- 印刷 / 实物 ----
  { id: 'print-a4', label: 'A4 传单 / 文档配图', ratio: '1.414:1',
    comp: 'A4 比例，主体居中，四周留出出血安全区' },
  { id: 'print-poster', label: '海报', ratio: '3:4',
    comp: '竖版海报构图，主体偏上，下方留白放标题' },
  { id: 'print-photo', label: '照片 / 6 寸冲印', ratio: '3:2',
    comp: '经典横构图，主体遵循三分法' },
  { id: 'card-business', label: '名片', ratio: '9:5',
    comp: '横向卡片构图，左侧留白放信息，右侧放主视觉' },

  // ---- 桌面 / 其他 ----
  { id: 'wallpaper', label: '壁纸 / 桌面背景', ratio: '16:9',
    comp: '横向满版，主体居中或偏右，避免画面中心被图标遮挡' },
  { id: 'wallpaper-ultrawide', label: '带鱼屏壁纸', ratio: '21:9',
    comp: '超宽横向构图，主体居中，两侧延展环境' },
  { id: 'sticker', label: '表情包 / 贴纸', ratio: '1:1',
    comp: '主体居中且充满画面，描边完整，纯色背景' },
];

export const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

// Keyword routing so the agent can pick a ratio even when the user only describes
// the thing ("给我做个按钮"), never the format.
const KEYWORDS = [
  [/按钮|按键|title bar|标题条|条幅/i, 'ui-button'],
  [/图标|icon|道具|技能图标/i, 'ui-icon'],
  [/面板|弹窗|dialog|卡片底/i, 'ui-panel'],
  [/立绘|卡面|角色卡/i, 'game-portrait'],
  [/启动页|开屏|splash/i, 'game-splash'],
  [/场景|背景图|地形/i, 'game-scene'],
  [/主视觉|宣传图|key art|封面/i, 'game-hero'],
  [/小红书/i, 'social-xiaohongshu'],
  [/抖音|reels|故事|短视频/i, 'social-vertical'],
  [/公众号|头图/i, 'social-wechat-cover'],
  [/视频封面|b站|youtube/i, 'social-video'],
  [/头像|avatar/i, 'avatar'],
  [/朋友圈|instagram 方|方图/i, 'social-square'],
  [/电商|商品主图|主图/i, 'ecom-main'],
  [/banner|横幅/i, 'ecom-banner'],
  [/详情页|长图/i, 'ecom-detail'],
  [/a4|传单|文档/i, 'print-a4'],
  [/海报|poster/i, 'print-poster'],
  [/名片/i, 'card-business'],
  [/壁纸|wallpaper/i, 'wallpaper'],
  [/表情|贴纸|sticker/i, 'sticker'],
  [/照片|冲印/i, 'print-photo'],
];

export function suggestCategory(brief) {
  for (const [re, id] of KEYWORDS) {
    if (re.test(brief)) return CATEGORY_MAP[id];
  }
  return null;
}

// Build the final prompt. The ratio clause is always first: it is the single
// strongest lever on Doubao's output canvas.
export function composePrompt({ subject, category, ratio, allowText = false, extra = '' }) {
  const cat = category ? CATEGORY_MAP[category] : null;
  const useRatio = ratio || (cat ? cat.ratio : '1:1');
  const orient = orientation(useRatio);
  const [w, h] = pixelSize(useRatio, 2048);
  const comp = cat ? cat.comp : '主体居中，构图完整，四周留白均匀';

  let p = '生成一张 ' + useRatio + '（' + w + '×' + h + '）' + orient + '图片：' + String(subject).trim().replace(/。$/, '');
  p += '。构图要求：' + comp + '。';
  if (extra) p += extra.trim().replace(/。$/, '') + '。';
  if (!allowText) p += '画面中不要出现任何文字。';
  return p;
}

export function checkRatio(width, height, ratio, tolerance = 0.06) {
  const [rw, rh] = RATIO_SIZES[ratio] || [1, 1];
  const target = rw / rh;
  const actual = width / height;
  const err = Math.abs(actual - target) / target;
  return { ok: err <= tolerance, target: +target.toFixed(3), actual: +actual.toFixed(3), error: +err.toFixed(3) };
}
