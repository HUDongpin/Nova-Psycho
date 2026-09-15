import { describe,it,expect,vi,afterEach } from "vitest";
import { api,ApiError,apiUrl,eligibleScales,errorMessage,isAdult,isStaff,type Family,type Scale } from "../src/components/api";
import { copy,dictionary,formatDate,roleName,statusName } from "../src/components/copy";

afterEach(()=>vi.unstubAllGlobals());

describe("apiUrl",()=>{
  it("appends the locale as the first query parameter",()=>{
    expect(apiUrl("/api/workspace","zh-CN")).toBe("/api/workspace?locale=zh-CN");
  });
  it("appends with & when a query string already exists",()=>{
    expect(apiUrl("/api/reports/x/document?foo=1","zh-HK")).toBe("/api/reports/x/document?foo=1&locale=zh-HK");
  });
});

describe("api transport",()=>{
  const respond=(body:unknown,status=200)=>vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}})));
  // Typed with the real fetch signature so mock.calls exposes the request init.
  const spyFetch=()=>vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify({}),{status:200}));
  it("returns the parsed payload on success",async()=>{
    respond({ok:true});await expect(api("/api/session","zh-CN")).resolves.toEqual({ok:true});
  });
  it("sends the body as JSON and marks the content type",async()=>{
    const spy=spyFetch();
    vi.stubGlobal("fetch",spy);
    await api("/api/goals","zh-CN",{method:"POST",body:{title:"x"}});
    const init=spy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({title:"x"}));
    expect((init.headers as Record<string,string>)["Content-Type"]).toBe("application/json");
  });
  it("does not set a content type when there is no body",async()=>{
    const spy=spyFetch();
    vi.stubGlobal("fetch",spy);
    await api("/api/session","zh-CN");
    expect((spy.mock.calls[0][1] as RequestInit).headers).toEqual({});
  });
  it("raises an ApiError carrying the server code and status",async()=>{
    respond({error:"该量表版本已停用。",code:"SCALE_RETIRED"},409);
    await expect(api("/api/assessments","zh-CN")).rejects.toMatchObject({code:"SCALE_RETIRED",status:409});
  });
  it("falls back to a localised message when the error body is not JSON",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response("<html>bad gateway</html>",{status:502})));
    await expect(api("/api/session","zh-HK")).rejects.toMatchObject({code:"REQUEST_FAILED",status:502,message:"服務暫時未能回應，請重試。"});
  });
  it("produces a real ApiError instance",async()=>{
    respond({error:"x",code:"Y"},500);
    await expect(api("/api/session","zh-CN")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("errorMessage",()=>{
  it("uses the message of an Error",()=>{expect(errorMessage(new Error("boom"))).toBe("boom");});
  it("stringifies a non-Error",()=>{expect(errorMessage("plain")).toBe("plain");});
});

describe("role helpers",()=>{
  it("treats admin and staff as staff",()=>{
    expect(isStaff("admin")).toBe(true);expect(isStaff("staff")).toBe(true);
    expect(isStaff("parent")).toBe(false);expect(isStaff("teacher")).toBe(false);
  });
  it("treats staff and parents as adults, but not students or teachers",()=>{
    expect(isAdult("admin")).toBe(true);expect(isAdult("parent")).toBe(true);
    expect(isAdult("student")).toBe(false);expect(isAdult("teacher")).toBe(false);
  });
});

describe("eligibleScales",()=>{
  const scale=(over:Partial<Scale>):Scale=>({id:"s",scaleId:"s",version:"1.0.0",title:"t",description:"d",demo:true,minAge:6,maxAge:18,roles:["student"],retakeDays:14,source:"x",rights:"y",status:"active",...over});
  const family=(over:Partial<Family>={}):Family=>({id:"f",familyName:"F",childName:"C",age:12,birthDate:"2013-01-01",grade:"g",region:"CN",guardianLabel:"m",assignedTo:null,createdAt:"2026-01-01T00:00:00Z",consent:true,members:[{id:"u1",name:"S",role:"student"}],...over});
  const all=[scale({id:"ok"}),scale({id:"retired",status:"retired"}),scale({id:"too_old",minAge:15,maxAge:18}),scale({id:"teacher_only",roles:["teacher"]})];

  it("keeps only active instruments matching the respondent's role and the child's age",()=>{
    expect(eligibleScales(all,family(),"u1").map(s=>s.id)).toEqual(["ok"]);
  });
  it("honours the age ceiling as well as the floor",()=>{
    expect(eligibleScales(all,family({age:17}),"u1").map(s=>s.id)).toEqual(["ok","too_old"]);
  });
  it("returns nothing when the respondent is not a member of the family",()=>{
    expect(eligibleScales(all,family(),"stranger")).toEqual([]);
  });
  it("returns nothing when there is no family at all",()=>{
    expect(eligibleScales(all,undefined,"u1")).toEqual([]);
  });
  it("matches on the member's role, not the requested id",()=>{
    const teacherFamily=family({members:[{id:"u2",name:"T",role:"teacher"}]});
    expect(eligibleScales(all,teacherFamily,"u2").map(s=>s.id)).toEqual(["teacher_only"]);
  });
});

describe("bilingual copy",()=>{
  const entries=Object.entries(dictionary);
  it("defines a non-empty simplified and traditional string for every key",()=>{
    const broken=entries.filter(([,pair])=>!Array.isArray(pair)||pair.length!==2||pair.some(value=>typeof value!=="string"||value.trim().length===0));
    expect(broken.map(([key])=>key)).toEqual([]);
  });
  it("covers a substantial surface so an accidental deletion is caught",()=>{
    expect(entries.length).toBeGreaterThan(80);
  });
  it("serves the requested locale for every key",()=>{
    for(const [key,pair] of entries){
      expect(copy("zh-CN")(key as never)).toBe(pair[0]);
      expect(copy("zh-HK")(key as never)).toBe(pair[1]);
    }
  });
  it("actually differentiates traditional Chinese where the wording differs",()=>{
    const differing=entries.filter(([,pair])=>pair[0]!==pair[1]);
    expect(differing.length).toBeGreaterThan(20);
  });
  it("never leaks a placeholder or an empty translation",()=>{
    for(const [key,pair] of entries)for(const value of pair)expect(value,`${key}`).not.toMatch(/TODO|FIXME|undefined|null/);
  });
});

describe("localised labels",()=>{
  it("names every role in both locales",()=>{
    for(const role of ["admin","staff","parent","student","teacher"] as const){
      expect(roleName(role,"zh-CN").length).toBeGreaterThan(0);
      expect(roleName(role,"zh-HK").length).toBeGreaterThan(0);
    }
  });
  it("names every assessment status in both locales",()=>{
    for(const status of ["pending","queued","published","failed"] as const){
      expect(statusName(status,"zh-CN").length).toBeGreaterThan(0);
      expect(statusName(status,"zh-HK").length).toBeGreaterThan(0);
    }
  });
});

describe("formatDate",()=>{
  it("formats a valid ISO timestamp",()=>{
    expect(formatDate("2026-09-15T00:00:00Z","zh-CN")).toMatch(/2026/);
  });
  it("returns the original value rather than 'Invalid Date'",()=>{
    expect(formatDate("not-a-date","zh-CN")).toBe("not-a-date");
  });
  it("includes a time component only when asked",()=>{
    expect(formatDate("2026-09-15T10:30:00Z","zh-CN",true)).not.toBe(formatDate("2026-09-15T10:30:00Z","zh-CN"));
  });
});
