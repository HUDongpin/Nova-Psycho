import { describe,it,expect,afterEach,vi } from "vitest";
import { ageAt,familyScope,iso } from "../src/lib/access";
import { checkOrigin,HttpError,localeOf,requireRole,validateId } from "../src/lib/http";
import type { Actor,Role } from "../src/domain/types";

// These are the primitives that decide who can reach which family, so they are worth
// pinning even though the integration script also exercises them end to end: a change
// here fails silently by widening access rather than by throwing.

const actor=(role:Role,over:Partial<Actor>={}):Actor=>({id:"11111111-2222-4333-8444-555555555555",name:"Synthetic",role,region:"CN",...over});

afterEach(()=>vi.unstubAllEnvs());

describe("family scope by role",()=>{
  it("scopes an administrator to the region only",()=>{
    const scope=familyScope(actor("admin"));
    expect(scope.sql).toBe("f.region=$1");
    expect(scope.values).toEqual(["CN"]);
  });
  it("scopes staff to the families assigned to them",()=>{
    const scope=familyScope(actor("staff"));
    expect(scope.sql).toBe("f.region=$1 AND f.assigned_to=$2");
    expect(scope.values).toEqual(["CN",actor("staff").id]);
  });
  it.each(["parent","student","teacher"] as const)("scopes a %s through their membership, including the role",role=>{
    const scope=familyScope(actor(role));
    expect(scope.sql).toContain("EXISTS(SELECT 1 FROM memberships m");
    expect(scope.sql).toContain("m.user_id=$2");
    expect(scope.sql).toContain("m.role=$3");
    expect(scope.values).toEqual(["CN",actor(role).id,role]);
  });
  it("never lets a non-admin scope omit the region",()=>{
    for(const role of ["admin","staff","parent","student","teacher"] as const){
      expect(familyScope(actor(role)).sql).toContain("f.region=$1");
    }
  });
  it("shifts every placeholder when the caller reserves earlier parameters",()=>{
    expect(familyScope(actor("admin"),2).sql).toBe("f.region=$2");
    expect(familyScope(actor("staff"),2).sql).toBe("f.region=$2 AND f.assigned_to=$3");
    const parent=familyScope(actor("parent"),2);
    expect(parent.sql).toContain("m.user_id=$3");
    expect(parent.sql).toContain("m.role=$4");
    expect(parent.values).toHaveLength(3);
  });
  it("keeps values aligned with placeholders for every role",()=>{
    for(const role of ["admin","staff","parent","student","teacher"] as const){
      const {sql,values}=familyScope(actor(role));
      const highest=Math.max(...[...sql.matchAll(/\$(\d+)/g)].map(match=>Number(match[1])));
      expect(values,`${role}: placeholders go up to $${highest}`).toHaveLength(highest);
    }
  });
});

describe("age calculation",()=>{
  it("counts a birthday that has already passed this year",()=>{
    expect(ageAt("2013-04-12",new Date("2026-09-15T00:00:00Z"))).toBe(13);
  });
  it("does not count a birthday that has not arrived yet",()=>{
    expect(ageAt("2013-04-12",new Date("2026-04-11T00:00:00Z"))).toBe(12);
  });
  it("counts the birthday itself",()=>{
    expect(ageAt("2013-04-12",new Date("2026-04-12T00:00:00Z"))).toBe(13);
  });
});

describe("iso timestamps",()=>{
  it("passes null through rather than inventing a date",()=>{expect(iso(null)).toBeNull();});
  it("normalises a date to ISO",()=>{expect(iso(new Date("2026-09-15T00:00:00Z"))).toBe("2026-09-15T00:00:00.000Z");});
});

describe("origin validation",()=>{
  const withOrigin=(origin:string|null)=>new Request("http://127.0.0.1:3100/api/goals",{method:"POST",headers:origin===null?{}:{Origin:origin}});
  const config=()=>{vi.stubEnv("NOVA_REGION","CN");vi.stubEnv("NOVA_MODE","demo");vi.stubEnv("DATABASE_URL","postgresql://synthetic.invalid/nova");vi.stubEnv("NOVA_PUBLIC_URL","http://127.0.0.1:3100");vi.stubEnv("NOVA_REPORT_DIR","work/test-private");vi.stubEnv("NOVA_REPORT_KEY","0".repeat(64));};
  it("accepts a write from the configured origin",()=>{config();expect(()=>checkOrigin(withOrigin("http://127.0.0.1:3100"))).not.toThrow();});
  it("rejects a write from another origin",()=>{config();expect(()=>checkOrigin(withOrigin("http://evil.invalid"))).toThrow();});
  it("rejects a write with no Origin header at all",()=>{config();expect(()=>checkOrigin(withOrigin(null))).toThrow();});
  it("reports the refusal as ORIGIN_DENIED with status 403",()=>{
    config();
    try{checkOrigin(withOrigin("http://evil.invalid"));expect.unreachable();}
    catch(error){expect(error).toBeInstanceOf(HttpError);expect(error).toMatchObject({status:403,code:"ORIGIN_DENIED"});}
  });
});

describe("role enforcement",()=>{
  it("allows a listed role",()=>{expect(()=>requireRole("admin",["admin","staff"])).not.toThrow();});
  it("refuses an unlisted role",()=>{expect(()=>requireRole("parent",["admin","staff"])).toThrow();});
  it("reports the refusal as ROLE_DENIED with status 403",()=>{
    try{requireRole("student",["admin"]);expect.unreachable();}
    catch(error){expect(error).toMatchObject({status:403,code:"ROLE_DENIED"});}
  });
  it("refuses everyone when the allow list is empty",()=>{expect(()=>requireRole("admin",[])).toThrow();});
});

describe("record id validation",()=>{
  it("accepts a canonical uuid",()=>{
    expect(validateId("11111111-2222-4333-8444-555555555555")).toBe("11111111-2222-4333-8444-555555555555");
  });
  it("accepts uppercase hex",()=>{
    expect(()=>validateId("11111111-2222-4333-8444-55555555555A")).not.toThrow();
  });
  it.each(["","not-a-uuid","11111111-2222-4333-8444-55555555555","11111111222243338444555555555555","'; DROP TABLE families; --"])(
    "rejects %s before it can reach a query",
    value=>{expect(()=>validateId(value)).toThrow();}
  );
  it("reports a bad id as a 404 rather than a 400, so it does not confirm existence",()=>{
    try{validateId("nope");expect.unreachable();}
    catch(error){expect(error).toMatchObject({status:404,code:"NOT_FOUND"});}
  });
});

describe("locale parsing",()=>{
  const request=(query:string)=>new Request(`http://127.0.0.1:3100/api/workspace${query}`);
  it("defaults to simplified Chinese",()=>{expect(localeOf(request(""))).toBe("zh-CN");});
  it("honours an explicit traditional request",()=>{expect(localeOf(request("?locale=zh-HK"))).toBe("zh-HK");});
  it("falls back to simplified for an unknown locale",()=>{expect(localeOf(request("?locale=en-US"))).toBe("zh-CN");});
});
