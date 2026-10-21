export const reportGardenStyle = `
*{box-sizing:border-box}
html{scroll-padding-top:20px}
body{margin:0;background:#f1f3e9;color:#293d34;font:19px/1.8 "PingFang SC","PingFang HK","Hiragino Sans GB","Noto Sans SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;text-autospace:normal}
article{max-width:900px;margin:28px auto;padding:40px 56px;background:#fffef9;border:1px solid #dce4d2;border-radius:22px;box-shadow:0 8px 32px #364e3010}
header{position:relative;border-bottom:1px solid #dce4d2;padding-bottom:24px}
.brand{font-family:"Songti SC","Songti TC","Noto Serif SC","PMingLiU",serif;font-size:23px;letter-spacing:-.03em;color:#365e49;font-weight:560}
.garden-report-art{display:block;width:300px;max-width:76%;height:auto;margin:0 auto 6px}
h1{font-family:"Songti SC","Songti TC","Noto Serif SC","PMingLiU",serif;font-size:37px;line-height:1.4;margin:10px 0 16px;font-weight:560;color:#293d34;overflow-wrap:anywhere}
h2,h3{overflow-wrap:anywhere;break-after:avoid;page-break-after:avoid}
h2{font-family:"Songti SC","Songti TC","Noto Serif SC","PMingLiU",serif;font-size:26px;line-height:1.5;margin:30px 0 14px;font-weight:560}
h3{font-size:19px;line-height:1.6;margin:0 0 8px}
.chapter-title{display:flex;align-items:center;gap:12px;scroll-margin-top:20px}
.chapter-title>span{min-width:0}
.chapter-icon{display:block;width:44px;height:44px;flex:0 0 44px}
h3 .chapter-icon{width:36px;height:36px;flex-basis:36px}
p{margin:8px 0;overflow-wrap:anywhere;orphans:3;widows:3}
.intro,.meta,.band,.limitation{color:#53664f}
.meta{font-size:15px;line-height:1.7}
.facts{display:flex;gap:8px 24px;flex-wrap:wrap;font-size:16px;color:#53664f}
.demo{padding:14px 18px;background:#f9efe0;color:#6a4a28;border:1px solid #e8d6ba;border-radius:12px;margin:22px 0;font-size:17px}
.risk{padding:18px 20px;background:#fff1eb;border:2px solid #bb7969;border-radius:12px;margin:22px 0;break-inside:avoid;page-break-inside:avoid}
.risk h2{margin:0 0 8px;color:#873c2e}
.risk .chapter-icon{width:36px;height:36px;flex-basis:36px}
.report-directory{padding:18px 20px;margin:24px 0 30px;background:#f3f5e9;border:1px solid #e0e6d5;border-radius:14px}
.report-directory>p{font-size:16px;font-weight:600;color:#53664f;margin:0 0 10px}
.report-directory ul{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 14px}
.report-directory li{min-width:0}
.report-directory a{display:flex;align-items:center;gap:8px;padding:5px 4px;color:#365e49;text-decoration:none;font-size:16px;line-height:1.5;border-radius:5px;min-height:36px;overflow-wrap:anywhere}
.report-directory a img{width:27px;height:27px;flex:0 0 27px}
.report-directory a:hover{background:#e6eddb;text-decoration:underline;text-underline-offset:4px}
.report-directory a:focus-visible{outline:2px solid #365e49;outline-offset:3px}
.dimension{padding:22px 0;border-top:1px solid #dce4d2;margin:0}
.dimension>h3{margin-bottom:14px}
.observation-views{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:start}
.observation-count-1{grid-template-columns:minmax(0,1fr)}
.observation-count-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.observation-view{min-width:0;background:#f2f5eb;border:1px solid #e1e8d7;border-radius:12px;padding:14px 15px}
.observation-view[data-role="parent"]{background:#faf1e5;border-color:#eddfc9}
.observation-view[data-role="teacher"]{background:#eef3f1;border-color:#dce6e0}
.observation-role{font-size:16px;font-weight:600;letter-spacing:.03em;color:#425d47;margin:0 0 8px}
.observation-view p{font-size:17px;line-height:1.8;margin:10px 0 0;break-inside:avoid}
.observation-view p>strong{display:block;font-size:16px;font-weight:600;margin-bottom:5px}
.portrait,.situations,.priorities,.words,.triad-comparison{border-top:1px solid #dce4d2;padding:8px 0 18px;margin-top:16px}
.content-note{padding:14px 18px;margin:12px 0;background:#f6f6ed;border-left:3px solid #c6d4b2;border-radius:0 10px 10px 0}
.content-note p:first-child{margin-top:0}
.content-note p:last-child{margin-bottom:0}
.words .content-note{background:#faf3e8;border-color:#d7bea0}
.words .content-note>p:last-child{white-space:pre-wrap}
.dim-head{display:flex;justify-content:space-between;gap:16px;align-items:center}
.dim-head h3{margin:0}
.score{font-family:"Songti SC","Songti TC","Noto Serif SC","PMingLiU",serif;font-size:28px;font-weight:560;white-space:nowrap}
.score small{font-size:16px;color:#53664f}
.meter{height:5px;background:#e3e9d8;margin:16px 0;border-radius:99px;overflow:hidden}
.meter span{display:block;height:100%;background:#658668;border-radius:99px}
.band{font-size:17px;margin-bottom:4px}
.advice{border-top:1px solid #dce4d2;padding:18px 0}
.advice h3{display:flex;gap:10px;align-items:center}
.advice p{margin:8px 0}
.next{background:#edf2e4;border:1px solid #dce4d2;border-radius:14px;padding:20px 22px;margin-top:26px;break-inside:avoid}
.next h2{margin:0 0 8px}
.next p{margin:0}
.comparison{border-top:1px solid #dce4d2;padding-top:14px}
.comparison-role{margin:22px 0}
.comparison-role h3{color:#365e49}
.comparison-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:16px}
.comparison-table th,.comparison-table td{padding:11px 9px;border-bottom:1px solid #dce4d2;text-align:right;vertical-align:top;overflow-wrap:anywhere}
.comparison-table th:first-child{width:46%;text-align:left}
.comparison-table thead{display:table-header-group;background:#f3f5e9}
.comparison-table tbody th{font-weight:500}
.comparison-table .meta{display:block;font-weight:400;font-size:14px}
.comparison-table tr{break-inside:avoid}
.empty{padding:18px;background:#f3f5e9;border-radius:10px}
.limitation{font-size:15px;margin-top:26px}
footer{margin-top:24px;padding-top:18px;border-top:1px solid #dce4d2;font-size:14px;color:#53664f}
@media(max-width:700px){article{margin:0;border:0;border-radius:0;padding:26px 22px}h1{font-size:31px}h2{font-size:24px}.garden-report-art{width:260px}.observation-views{grid-template-columns:minmax(0,1fr)}.report-directory{padding:16px}.report-directory ul{gap:4px 8px}.facts{gap:8px 16px}.comparison-table th,.comparison-table td{padding:8px 4px}.comparison-table th:first-child{width:40%}}
@media(max-width:380px){article{padding:22px 16px}.report-directory ul{grid-template-columns:minmax(0,1fr)}.dim-head{align-items:flex-start;gap:8px}.score{font-size:24px}.chapter-title{gap:8px}}
@page{size:A4;margin:14mm 14mm 18mm}
@media print{
body{background:#fff;color:#24352c;font-size:14px;line-height:1.7}
article{max-width:none;margin:0;padding:0;border:0;border-radius:0;box-shadow:none}
header{padding-bottom:14px;break-inside:avoid}
.brand{font-size:19px}
.garden-report-art{width:190px;max-width:40%;margin:0 auto 2px}
h1{font-size:27px;margin:6px 0 10px}
h2{font-size:20px;margin:20px 0 10px}
h3{font-size:15px}
.chapter-title{gap:8px}
.chapter-icon{width:30px;height:30px;flex-basis:30px}
h3 .chapter-icon,.risk .chapter-icon{width:26px;height:26px;flex-basis:26px}
.facts{font-size:13px;gap:4px 18px}
.demo{font-size:13px;padding:10px 12px;margin:14px 0}
.risk{padding:12px 14px;margin:16px 0;border-width:1.5px}
.report-directory{padding:10px 12px;margin:16px 0 20px;break-inside:avoid}
.report-directory>p{font-size:13px;margin-bottom:5px}
.report-directory ul{grid-template-columns:repeat(3,minmax(0,1fr));gap:2px 8px}
.report-directory a{font-size:12px;min-height:24px;padding:2px;gap:5px}
.report-directory a img{width:20px;height:20px;flex-basis:20px}
.dimension{padding:14px 0;break-inside:auto}
.scored-dimension{break-inside:avoid}
.dimension>h3{margin-bottom:10px}
.observation-views{display:block}
.observation-view{padding:10px 13px;margin-bottom:8px;border-radius:8px;break-inside:avoid}
.observation-role{font-size:13px;margin:0 0 5px;break-after:avoid}
.observation-view p{font-size:14px;line-height:1.7;margin:6px 0 0;break-inside:avoid}
.observation-view p>strong{font-size:13px;margin-bottom:3px}
.portrait,.situations,.priorities,.words,.triad-comparison{padding:4px 0 10px;margin-top:10px}
.portrait>.meta,.situations>.meta,.triad-comparison>p:first-of-type,.comparison-role>.meta{break-after:avoid}
.content-note{padding:10px 12px;margin:8px 0;break-inside:avoid}
.content-note>p:first-child{break-after:avoid}
.score{font-size:23px}.score small{font-size:13px}
.meter{height:4px;margin:10px 0}
.band{font-size:14px}
.advice{padding:12px 0;break-inside:auto}.advice h3{break-after:avoid}
.next{padding:14px 16px;margin-top:18px}
.comparison-role{margin:16px 0}
.comparison-table{font-size:13px}.comparison-table th,.comparison-table td{padding:7px 6px}.comparison-table .meta{font-size:12px}
.meta,.limitation{font-size:12px;color:#46573f}.limitation{margin-top:18px}
footer{font-size:12px;margin-top:18px;padding-top:12px}
}
`;
