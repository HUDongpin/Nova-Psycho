import type { AdviceLibrary, ReportTemplate, ScaleDefinition, TextPair } from "./types";
const l=(cn:string,hk=cn):TextPair=>({"zh-CN":cn,"zh-HK":hk});
const choices=[l("从不","從不"),l("偶尔","偶爾"),l("有时","有時"),l("经常","經常")].map((label,value)=>({value,label}));
export const demoScale:ScaleDefinition={
  id:"nova-family-demo",version:"1.0.0",title:l("家庭沟通与日常感受 · 演示","家庭溝通與日常感受 · 示範"),
  description:l("9 道虚构示例题，用于体验作答、规则计分和自动报告。不是心理健康量表，没有临床常模，不用于判断孩子的心理健康状态。","9 道虛構示例題，用於體驗作答、規則計分和自動報告。不是心理健康量表，沒有臨床常模，不用於判斷孩子的心理健康狀態。"),
  demo:true,source:"Nova 原创流程演示；无临床验证",rights:{digital:true,commercial:true,reference:"Nova original demonstration content. Not a validated clinical instrument."},
  minAge:6,maxAge:18,regions:["CN","HK"],roles:["student","parent","teacher"],retakeDays:14,
  norm:{label:l("演示规则，无临床常模","示範規則，沒有臨床常模"),source:"Synthetic workflow demonstration only",regions:["CN","HK"],minAge:6,maxAge:18,validated:false},
  items:[
    {id:"q1",label:l("表达自己的想法时，我担心不被理解。","表達自己的想法時，我擔心不被理解。"),observerLabel:l("孩子表达自己的想法时，似乎担心不被理解。","孩子表達自己的想法時，似乎擔心不被理解。"),choices,reverse:false,required:false},
    {id:"q2",label:l("家里有人愿意听我把话说完。","家裏有人願意聽我把話說完。"),observerLabel:l("家里有人愿意听孩子把话说完。","家裏有人願意聽孩子把話說完。"),choices,reverse:true,required:false},
    {id:"q3",label:l("和家人意见不同时，我很难平静地交流。","和家人意見不同時，我很難平靜地交流。"),observerLabel:l("意见不同时，孩子与家人很难平静地交流。","意見不同時，孩子與家人很難平靜地交流。"),choices,reverse:false,required:false},
    {id:"q4",label:l("我可以向信任的大人提出需要。","我可以向信任的大人提出需要。"),observerLabel:l("孩子可以向信任的大人提出需要。","孩子可以向信任的大人提出需要。"),choices,reverse:true,required:false},
    {id:"q5",label:l("一天结束时，我觉得没有足够的休息时间。","一天結束時，我覺得沒有足夠的休息時間。"),observerLabel:l("一天结束时，孩子似乎没有足够的休息时间。","一天結束時，孩子似乎沒有足夠的休息時間。"),choices,reverse:false,required:false},
    {id:"q6",label:l("我的一天里有一段可以自主安排的时间。","我的一天裏有一段可以自主安排的時間。"),observerLabel:l("孩子的一天里有一段可以自主安排的时间。","孩子的一天裏有一段可以自主安排的時間。"),choices,reverse:true,required:false},
    {id:"q7",label:l("面对很多任务时，我不知道从哪里开始。","面對很多任務時，我不知道從哪裏開始。"),observerLabel:l("面对很多任务时，孩子似乎不知道从哪里开始。","面對很多任務時，孩子似乎不知道從哪裏開始。"),choices,reverse:false,required:false},
    {id:"q8",label:l("有不顺利的事情时，我能找到适合自己的放松方式。","有不順利的事情時，我能找到適合自己的放鬆方式。"),observerLabel:l("有不顺利的事情时，孩子能找到适合自己的放松方式。","有不順利的事情時，孩子能找到適合自己的放鬆方式。"),choices,reverse:true,required:false},
    {id:"q9",label:l("我现在需要可信任的大人立即帮助我保证安全。","我現在需要可信任的大人立即幫助我確保安全。"),observerLabel:l("孩子现在需要可信任的大人立即帮助其保证安全。","孩子現在需要可信任的大人立即幫助其確保安全。"),choices:[{value:0,label:l("否")},{value:1,label:l("是")}],reverse:false,required:true}
  ],
  dimensions:[
    {key:"connection",label:l("家庭沟通","家庭溝通"),items:["q1","q2","q3","q4"],aggregation:"sum",maxMissing:0,prorate:false,higherMeans:"more_support",bands:[
      {minimum:0,key:"maintain",label:l("保持支持 · 演示","保持支持 · 示範"),explanation:l("这组示例回答呈现出较多可以延续的沟通支持。可以继续了解孩子愿意保留哪些相处方式。","這組示例回答呈現出較多可以延續的溝通支持。可以繼續了解孩子願意保留哪些相處方式。"),adviceIds:["listen"]},
      {minimum:4,key:"explore",label:l("一起了解 · 演示","一起了解 · 示範"),explanation:l("这组示例回答提示，可以留出时间了解哪些交流情境让孩子感到困难。","這組示例回答提示，可以留出時間了解哪些交流情境讓孩子感到困難。"),adviceIds:["listen","check_in"]},
      {minimum:8,key:"support",label:l("增加支持 · 演示","增加支持 · 示範"),explanation:l("这组示例回答提示，在日常交流中增加倾听和表达选择，可能是值得一起尝试的方向。","這組示例回答提示，在日常交流中增加聆聽和表達選擇，可能是值得一起嘗試的方向。"),adviceIds:["listen","check_in"]}
    ]},
    {key:"daily",label:l("日常节奏","日常節奏"),items:["q5","q6","q7","q8"],aggregation:"sum",maxMissing:0,prorate:false,higherMeans:"more_support",bands:[
      {minimum:0,key:"maintain",label:l("保持支持 · 演示","保持支持 · 示範"),explanation:l("这组示例回答显示，日常生活中存在可继续保持的休息和自主安排空间。","這組示例回答顯示，日常生活中存在可繼續保持的休息和自主安排空間。"),adviceIds:["routine"]},
      {minimum:4,key:"explore",label:l("一起了解 · 演示","一起了解 · 示範"),explanation:l("这组示例回答提示，可以一起看看每天的任务与休息是否有调整空间。","這組示例回答提示，可以一起看看每天的任務與休息是否有調整空間。"),adviceIds:["routine","small_steps"]},
      {minimum:8,key:"support",label:l("增加支持 · 演示","增加支持 · 示範"),explanation:l("这组示例回答提示，可以帮助孩子减少同时面对的任务，并一起安排可行的休息时间。","這組示例回答提示，可以幫助孩子減少同時面對的任務，並一起安排可行的休息時間。"),adviceIds:["routine","small_steps"]}
    ]}
  ],
  riskRules:[{itemId:"q9",values:[1],message:l("作答出现了需要立即关注安全的信号。请先帮助孩子联系安全、可信任的成人或专业服务；如存在眼前的危险，请联系当地紧急服务。不要等待下一次测评。","作答出現了需要立即關注安全的訊號。請先幫助孩子聯絡安全、可信任的成人或專業服務；如存在眼前的危險，請聯絡當地緊急服務。不要等待下一次測評。")}]
};
export const demoAdvice:AdviceLibrary={title:l("Nova 家庭支持建议库 · 演示","Nova 家庭支持建議庫 · 示範"),blocks:[
  {id:"listen",title:l("留一段不急着给答案的时间","留一段不急着給答案的時間"),body:l("选择双方都比较放松的时刻，先询问孩子是否愿意聊一聊。听完后，用自己的话确认是否理解，再询问孩子想要倾听、建议，还是一起解决问题。","選擇雙方都比較放鬆的時刻，先詢問孩子是否願意聊一聊。聽完後，用自己的話確認是否理解，再詢問孩子想要聆聽、建議，還是一起解決問題。"),source:"Nova 原创家庭沟通示例，不代表临床干预方案",dimensionKeys:["connection"]},
  {id:"check_in",title:l("先理解感受，再讨论安排","先理解感受，再討論安排"),body:l("遇到分歧时，可以先说出观察到的具体情境，避免给孩子贴标签。把每次讨论限制在一个可以共同商量的问题上，允许孩子选择稍后再谈。","遇到分歧時，可以先說出觀察到的具體情境，避免給孩子貼標籤。把每次討論限制在一個可以共同商量的問題上，允許孩子選擇稍後再談。"),source:"Nova 原创家庭沟通示例，不代表临床干预方案",dimensionKeys:["connection"]},
  {id:"routine",title:l("共同安排可预期的休息","共同安排可預期的休息"),body:l("和孩子一起查看一天的安排，找出一段可自主选择活动的时间。记录哪些安排让双方感到更舒适，下一次再一起调整，不把完成情况变成新的考核。","和孩子一起查看一天的安排，找出一段可自主選擇活動的時間。記錄哪些安排讓雙方感到更舒適，下一次再一起調整，不把完成情況變成新的考核。"),source:"Nova 原创日常支持示例，不代表临床干预方案",dimensionKeys:["daily"]},
  {id:"small_steps",title:l("把任务缩小到可开始的一步","把任務縮小到可開始的一步"),body:l("当事情显得太多时，询问孩子愿意先从哪一小步开始。先认可尝试，再一起决定是否需要更多帮助。持续的困难应结合实际生活表现寻求专业了解。","當事情顯得太多時，詢問孩子願意先從哪一小步開始。先認可嘗試，再一起決定是否需要更多幫助。持續的困難應結合實際生活表現尋求專業了解。"),source:"Nova 原创日常支持示例，不代表临床干预方案",dimensionKeys:["daily"]}
]};
export const demoTemplate:ReportTemplate={
  title:l("家庭支持测评报告","家庭支持測評報告"),
  introduction:l("从一次倾听开始，了解孩子眼中的日常。以下内容帮助家庭整理观察，选择可以共同尝试的下一步。","從一次聆聽開始，了解孩子眼中的日常。以下內容幫助家庭整理觀察，選擇可以共同嘗試的下一步。"),
  limitation:l("测评结果反映本次作答，不能替代面对面的专业评估。单次得分或前后变化不能证明心理疾病、家庭原因或辅导疗效。未触发风险提示也不代表没有风险。","測評結果反映本次作答，不能替代面對面的專業評估。單次得分或前後變化不能證明心理疾病、家庭原因或輔導療效。未觸發風險提示也不代表沒有風險。"),
  nextStep:l("从建议中选择一项双方都愿意尝试的行动，并记录感受。复测时结合生活观察一起理解变化。若困难持续或加重，联系合适的专业人员。","從建議中選擇一項雙方都願意嘗試的行動，並記錄感受。複測時結合生活觀察一起理解變化。若困難持續或加重，聯絡合適的專業人員。")
};
