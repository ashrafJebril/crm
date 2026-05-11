import "reflect-metadata";
import { EnrichmentService } from "../src/mentions/enrichment.service";

async function main() {
  const svc = new EnrichmentService();
  const cases = [
    "Just got my Samemha shirt — quality is amazing! Will order more.",
    "ما وصلني الطلب من سَمِّمها لين الحين، تأخروا أسبوع كامل!",
    "بصراحة الطباعة حلوة بس التوصيل بطيء شوي",
  ];
  for (const c of cases) {
    console.log("\n>>>", c);
    console.log(await svc.enrich(c));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
