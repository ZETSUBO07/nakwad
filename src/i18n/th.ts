/**
 * Every piece of text the app shows, in Thai.
 * Code never writes Thai directly (a lint rule enforces it); it calls t("key") instead.
 * To add a language later: copy this file, keep every key, translate the values.
 * Placeholders look like {name} and are filled by t("key", { name }).
 */
export const th = {
  appName: "นักวาดมือฉมัง",
  appTagline: "แอปวาดรูปสำหรับแท็บเล็ตกับปากกา",
  buildingNotice: "กำลังสร้างรุ่น 1 หน้านี้ใช้ตรวจว่าการเผยแพร่ทำงาน",
  versionLabel: "เวอร์ชัน {version}",
} as const;

export type MessageKey = keyof typeof th;
