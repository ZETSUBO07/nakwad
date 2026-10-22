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
  openLab: "ลองหัวปากกา",

  // brush names
  brushPen: "ปากกาลูกลื่น",
  brushPencil: "ดินสอ",
  brushInk: "พู่กันหมึก",
  brushNib: "ปากกาหัวตัด",
  brushMarker: "มาร์กเกอร์",
  brushSpray: "สเปรย์",
  brushEraser: "ยางลบเส้น",
  brushEraserall: "ยางลบทั้งหมด",

  // brush lab (milestone M4): a page to try the drawing engine on the tablet
  labTitle: "ห้องทดลองหัวปากกา",
  labHint: "หน้านี้ไว้ลองหัวปากกาก่อนแอปจริงเสร็จ งานในหน้านี้ไม่ถูกบันทึก",
  labBack: "กลับหน้าแรก",
  labUndo: "ย้อนกลับ",
  labRedo: "ทำซ้ำ",
  labClear: "ล้างเลเยอร์",
  labLayerColor: "สีพื้นเลเยอร์",
  labSize: "ขนาด",
  labFrameTime: "วาดหนึ่งเฟรม {ms} มิลลิวินาที",
  // M5: pen and fingers
  labGestures: "สองนิ้ว: เลื่อน ซูม หมุน · แตะสองนิ้ว: ย้อนกลับ · แตะสามนิ้ว: ทำซ้ำ · หนีบนิ้วเข้าเร็ว ๆ: พอดีจอ",
  labFingerDraw: "นิ้ววาดได้",
  labStabilizer: "กันมือสั่น",
  labZoom: "{n}%",
  labFit: "พอดีจอ",
} as const;

export type MessageKey = keyof typeof th;
