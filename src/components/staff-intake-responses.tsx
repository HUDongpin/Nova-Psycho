import type { Locale, StaffIntakeResponse } from "./api";
import { formatDate, roleName } from "./copy";
import { SectionHeading } from "./ui";
import styles from "./staff-intake-responses.module.css";

export function StaffIntakeResponses({ responses, locale }: { responses: StaffIntakeResponse[]; locale: Locale }) {
  if (!responses.length) return null;
  const hk = locale === "zh-HK";
  return <section className={`panel ${styles.panel}`}>
    <SectionHeading title={hk ? "問卷答覆（僅工作人員可見）" : "问卷答复（仅工作人员可见）"}
      subtitle={hk ? "按填寫人及提交時間查看原有答覆，僅供授權服務跟進，不作評分。" : "按填写人及提交时间查看原有答复，仅供授权服务跟进，不作评分。"} />
    {responses.map(response => <details className={styles.response} key={response.assessmentId}>
      <summary>{roleName(response.role, locale)} · {formatDate(response.submittedAt, locale, true)}</summary>
      {response.sections.map((section, index) => <section key={index} className={styles.section}>
        <h3>{section.title}</h3>
        <dl>{section.items.map(item => <div key={item.itemId}>
          <dt>{item.label}</dt>
          <dd>{item.responses.join("；")}</dd>
        </div>)}</dl>
      </section>)}
    </details>)}
  </section>;
}
