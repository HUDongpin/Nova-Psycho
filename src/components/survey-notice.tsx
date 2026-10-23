import { useId } from "react";
import type { Locale } from "./api";
import { copy } from "./copy";

export function SurveyNotice({ locale, acknowledged, disabled, consentRequired, onAcknowledged, onOpen, studentSharing = false }: {
  locale: Locale;
  acknowledged: boolean;
  disabled: boolean;
  consentRequired: boolean;
  studentSharing?: boolean;
  onAcknowledged: (value: boolean) => void;
  onOpen: () => void;
}) {
  const headingId = useId();
  const hk = locale === "zh-HK";
  return <section className="survey-assent-panel" aria-labelledby={headingId}>
    <div data-testid="survey-notice-summary" className="survey-notice-summary">
      <h2 id={headingId}>{hk ? "作答前，請了解" : "作答前，请了解"}</h2>
      <ul>
        <li>{hk ? "問卷用於了解學習、家庭與成長情況，不提供醫學診斷。" : "问卷用于了解学习、家庭与成长情况，不提供医学诊断。"}</li>
        <li>{hk ? "完成所需問卷後，系統自動產生報告。報告按現有授權查看，服務人員按家庭分工存取資料。" : "完成所需问卷后，系统自动生成报告。报告按现有授权查看，服务人员按家庭分工访问资料。"}</li>
        <li>{hk ? "請按題目要求的時間範圍和真實情況作答，可以暫停。草稿會自動儲存，請以頁面儲存狀態為準。" : "请按题目要求的时间范围和真实情况作答，可以暂停。草稿会自动保存，请以页面保存状态为准。"}</li>
        {studentSharing && <li>{hk ? "普通答案和自由文字只供服務團隊按授權查看。最後可自願選擇最多三句支持需要，核對完整預覽並確認後才會分享給家長；選擇不分享仍可提交。安全問題仍按保護流程處理。" : "普通答案和自由文字只供服务团队按授权查看。最后可自愿选择最多三句支持需要，核对完整预览并确认后才会分享给家长；选择不分享仍可提交。安全问题仍按保护流程处理。"}</li>}
      </ul>
    </div>
    <button type="button" className="assent-link survey-notice-open" data-testid="survey-notice-open" aria-haspopup="dialog" onClick={event => { event.currentTarget.focus({ preventScroll: true }); onOpen(); }}>{hk ? "閱讀完整須知" : "阅读完整须知"}</button>
    <label className="checkbox-label">
      <input type="checkbox" checked={acknowledged} onChange={event => onAcknowledged(event.target.checked)} disabled={disabled} />
      <span>{hk ? "我已了解上述說明及私隱須知，自願作答。" : "我已了解上述说明及隐私须知，自愿作答。"}</span>
    </label>
    {consentRequired && <div className="warning-note">{copy(locale)("consentNeeded")}</div>}
  </section>;
}
