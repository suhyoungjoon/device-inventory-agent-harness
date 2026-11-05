// 차원 값·코드 → 화면 이름 (dimensions.yaml의 names와 같게 둔다)
export const FAMILY: Record<string, string> = { flagship: "플래그십", mid: "보급형", kids_senior: "키즈·시니어" };
export const PHASE: Record<string, string> = { new: "신규 출시", main: "주력", eol: "단종 예정" };
export const MAKER: Record<string, string> = { MA: "제조사 A", MB: "제조사 B", MC: "제조사 C" };
export const BAND: Record<string, string> = { early: "초반(1~3주)", middle: "중반(4~6주)", late: "후반(7~8주)" };
export const BRANCH: Record<string, string> = { A: "서초지점", B: "강남지점", C: "송파지점" };

export const VALUE_LABELS: Record<string, string> = { ...FAMILY, ...PHASE, ...MAKER, ...BAND, ...BRANCH };
