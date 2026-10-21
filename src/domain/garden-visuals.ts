/** Fixed decorative artwork shared by the app and frozen, offline report documents. */
const iconDrawings = {
  book: '<path d="M11 17c8-3 14-2 21 2 7-4 13-5 21-2v29c-8-3-14-2-21 2-7-4-13-5-21-2Z" fill="#fffdf6"/><path d="M32 19v29M17 25l9 2m-9 6 9 2m12-8 9-2m-9 10 9-2"/>',
  connection: '<path d="m12 27 10-9 10 4 10-4 10 9-15 18c-3 3-6 3-9 0Z" fill="#f7e8d8"/><path d="m12 27 10 5 10-10m-9 11 9 9m-4-14 14 11m-8-17 11 7m-7 16 8-11"/>',
  compass: '<circle cx="32" cy="32" r="21" fill="#fffdf6"/><path d="m39 23-4 13-13 7 6-15Z" fill="#a8c6ab"/><path d="m28 28 7 8M32 14v3m18 15h-3M32 50v-3M14 32h3"/>',
  calendar: '<rect x="13" y="17" width="38" height="34" rx="5" fill="#fffdf6"/><path d="M13 27h38M23 12v10m18-10v10m-20 13h5m10 0h5m-20 9h5m10 0h5"/>',
  school: '<path d="m9 29 23-16 23 16M15 27v24h34V27" fill="#fffdf6"/><path d="M28 51V37h9v14M22 31h2m16 0h2M31 15V9h10l-3 4H31"/>',
  heart: '<path d="M32 48S11 36 11 23c0-13 16-14 21-3 5-11 21-10 21 3 0 13-21 25-21 25Z" fill="#efd9cc"/><path d="M29 36c-1-8 5-13 13-13 0 9-5 14-13 13Zm-3 5 11-13" fill="#dce7cd"/>',
  leaf: '<path d="M16 46c-7-19 2-29 31-32 3 25-8 40-27 33" fill="#b8ceb3"/><path d="m13 53 28-31M24 42l-2-11m8 5 10 1"/>',
  words: '<path d="M13 16h38v29H30l-12 8v-8h-5Z" fill="#fffdf6"/><path d="M21 26h22M21 34h15"/>',
  comparison: '<path d="M10 17h23v34H10Z" fill="#d5e3d0"/><path d="M31 12h23v34H31Z" fill="#fffdf6"/><path d="M16 25h11m-11 7h8m13-12h11m-11 7h11m-11 7h8"/>',
  family: '<circle cx="20" cy="23" r="7" fill="#f7e8d8"/><circle cx="44" cy="23" r="7" fill="#f7e8d8"/><circle cx="32" cy="37" r="6" fill="#fffdf6"/><path d="M9 43c0-13 20-13 20-2m6 0c0-11 20-13 20 2M22 53c0-13 20-13 20 0"/>',
  shield: '<path d="m32 10 20 8v15c0 13-20 23-20 23S12 46 12 33V18Z" fill="#fffdf6"/><path d="m23 32 6 6 13-14"/>',
  send: '<path d="m10 30 44-17-15 40-10-17Z" fill="#fffdf6"/><path d="m29 36 25-23M29 36l-4 13 8-7"/>',
  check: '<circle cx="32" cy="32" r="21" fill="#d5e3d0"/><path d="m21 32 8 8 16-18"/>',
  clock: '<circle cx="32" cy="32" r="21" fill="#fffdf6"/><path d="M32 19v15l9 5M29 7h6"/>',
} as const;

export type GardenIconKey = keyof typeof iconDrawings;
export type GardenScene = "welcome" | "waiting" | "ready" | "report";

const dataUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const iconUris = Object.fromEntries(Object.entries(iconDrawings).map(([key, drawing]) => [key, dataUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M8 14C18 3 45 3 55 16c10 14 4 36-9 42C28 65 5 53 4 36 3 27 3 20 8 14Z" fill="#edf1e4"/><g fill="none" stroke="#486957" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${drawing}</g></svg>`)])) as Record<GardenIconKey, string>;

export function gardenIconUri(key: GardenIconKey): string { return iconUris[key]; }

const sectionIcons: Readonly<Record<string, GardenIconKey>> = {
  cognition: "book", connection: "connection", guidance: "compass", autonomy: "compass",
  curriculum: "calendar", community: "school", state: "heart", impact: "leaf",
  portrait: "family", situations: "words", priorities: "compass", words: "words",
  comparison: "comparison", safety: "shield", begin: "leaf", background: "family",
  family: "family", school: "school", daily: "calendar", future: "compass",
  hopes: "compass", support: "connection", resources: "leaf", feelings: "heart",
  learning: "book", relationship: "connection", fit: "calendar",
  scenes: "words", close: "words", youth: "compass",
};

export function gardenIconForSection(id: string): GardenIconKey { return Object.hasOwn(sectionIcons, id) ? sectionIcons[id] : "book"; }

function sceneSvg(scene: GardenScene): string {
  const centerpiece = scene === "waiting"
    ? '<g transform="translate(230 72)"><path d="M-50 20H42v12h-92Zm5 12v25m80-25v25M-43 20V4h77v16" fill="#e4d0ac" stroke="#768b6d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="2" cy="-6" r="24" fill="#f8f3e4" stroke="#768b6d" stroke-width="2"/><path d="M2-20v15l10 6" fill="none" stroke="#768b6d" stroke-width="2.5" stroke-linecap="round"/></g>'
    : '<g stroke="#70836b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m170 77 57 7 49-12 8 49-55 14-63-12Z" fill="#e1e8d3"/><path d="m170 72 58 7 49-13 3 50-51 13-60-12Z" fill="#fffdf3"/><path d="m228 79 1 50m-47-43 30 5m-29 5 29 5m-29 5 29 5m30-19 24-6m-24 17 24-6" stroke="#b8c4a8"/><path d="m242 73 3 21 8-7 6 3-3-21" fill="#c9d6b7" stroke="none"/></g>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 180"><path d="M30 141C4 103 20 47 71 35c49-12 66 6 116-8C268 3 321 27 358 29c85 4 111 56 85 99-19 33-98 28-151 27-98-1-200 24-262-14Z" fill="#edf0df"/><ellipse cx="252" cy="144" rx="172" ry="12" fill="#dce5cf"/><circle cx="367" cy="48" r="22" fill="#f4dfb0" opacity=".75"/><path d="M387 146c-42-34-79-25-95-10s-69 34-146 16" fill="none" stroke="#fcf8ed" stroke-width="16" stroke-linecap="round"/><path d="M390 146c-42-34-79-25-95-10" fill="none" stroke="#b8b89b" stroke-width="1.4" stroke-dasharray="2 7"/>${centerpiece}<g stroke="#6d8767" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m99 110 7 35h29l7-35Z" fill="#dfc9a9"/><path d="M96 107h49v9H96Z" fill="#e9d9bd"/><path d="M120 106V52" fill="none"/><path d="M120 90c-18-1-29-10-24-24 17-1 26 9 24 24Z" fill="#b9cda7"/><path d="M121 73c0-19 11-26 27-24 1 17-11 26-27 24Z" fill="#a6bf94"/><path d="M120 60c-13-3-18-13-12-24 12 1 17 11 12 24Z" fill="#cbd7b5"/><path d="M346 139v-36m0 20c-13-1-20-8-16-17 11 0 18 6 16 17Zm1-10c0-12 8-17 17-15 0 11-7 17-17 15Z" fill="#b4c9a1"/></g><g fill="#c1cba7"><ellipse cx="64" cy="126" rx="5" ry="3"/><ellipse cx="397" cy="112" rx="4" ry="3"/><ellipse cx="315" cy="42" rx="3" ry="2"/></g></svg>`;
}

const sceneUris: Readonly<Record<GardenScene, string>> = {
  welcome: dataUri(sceneSvg("welcome")), waiting: dataUri(sceneSvg("waiting")),
  ready: dataUri(sceneSvg("ready")), report: dataUri(sceneSvg("report")),
};

export function gardenSceneUri(scene: GardenScene): string { return sceneUris[scene]; }
