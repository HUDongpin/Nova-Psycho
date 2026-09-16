import { describe,it,expect,afterEach,vi } from "vitest";
import { ZodError,z } from "zod";
import { body,handle,HttpError,json } from "../src/lib/http";

afterEach(()=>vi.restoreAllMocks());

const parse=async(response:Response)=>JSON.parse(await response.text());

describe("json responses",()=>{
  it("defaults to 200 with a parseable body",async()=>{
    const response=json({ok:true});
    expect(response.status).toBe(200);
    expect(await parse(response)).toEqual({ok:true});
  });
  it("honours a custom status",async()=>{
    const response=json({error:"no"},403);
    expect(response.status).toBe(403);
    expect(await parse(response)).toEqual({error:"no"});
  });
  it("disables caching",()=>{
    expect(json({ok:true}).headers.get("Cache-Control")).toBe("no-store");
    expect(json({ok:true},201).headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("request body",()=>{
  const post=(init:RequestInit)=>new Request("http://127.0.0.1:3100/api/example",{method:"POST",...init});

  it("rejects a non-JSON content type",async()=>{
    try{
      await body(post({headers:{"content-type":"text/plain"},body:"{}"}));
      expect.unreachable();
    }catch(error){
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({status:415,code:"CONTENT_TYPE"});
    }
  });

  it("rejects a missing body",async()=>{
    try{
      await body(post({headers:{"content-type":"application/json"}}));
      expect.unreachable();
    }catch(error){
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({status:400,code:"INVALID_JSON"});
    }
  });

  it("rejects invalid JSON",async()=>{
    try{
      await body(post({headers:{"content-type":"application/json"},body:"{not-json"}));
      expect.unreachable();
    }catch(error){
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({status:400,code:"INVALID_JSON"});
    }
  });

  it("accepts a small valid JSON object",async()=>{
    await expect(body(post({headers:{"content-type":"application/json; charset=utf-8"},body:JSON.stringify({name:"合成"})}))).resolves.toEqual({name:"合成"});
  });

  it("rejects an oversized content-length before reading",async()=>{
    try{
      await body(post({headers:{"content-type":"application/json","content-length":"600001"},body:"{}"}));
      expect.unreachable();
    }catch(error){
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({status:413,code:"PAYLOAD_SIZE"});
    }
  });

  it("rejects a streaming payload that exceeds the size limit",async()=>{
    try{
      await body(post({headers:{"content-type":"application/json"},body:new Uint8Array(600001)}));
      expect.unreachable();
    }catch(error){
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({status:413,code:"PAYLOAD_SIZE"});
    }
  });
});

describe("error handling",()=>{
  it("maps an HttpError onto the matching JSON envelope",async()=>{
    const response=await handle(async()=>{throw new HttpError(403,"您没有执行此操作的权限。","ROLE_DENIED");});
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await parse(response)).toEqual({error:"您没有执行此操作的权限。",code:"ROLE_DENIED"});
  });

  it("maps a ZodError to 422 without leaking field paths",async()=>{
    let caught:ZodError|undefined;
    try{z.object({email:z.string().email(),secret:z.string()}).parse({email:"nope"});}
    catch(error){if(error instanceof ZodError)caught=error;}
    expect(caught).toBeInstanceOf(ZodError);
    const response=await handle(async()=>{throw caught!;});
    expect(response.status).toBe(422);
    const payload=await parse(response);
    expect(payload).toEqual({error:"输入不符合要求，请检查必填项和格式。",code:"VALIDATION_FAILED"});
    expect(JSON.stringify(payload)).not.toMatch(/email|secret|\.path|issues/);
  });

  it("maps a unique-violation-like error to 409",async()=>{
    const conflict=Object.assign(new Error("duplicate key value violates unique constraint"),{code:"23505"});
    const response=await handle(async()=>{throw conflict;});
    expect(response.status).toBe(409);
    expect(await parse(response)).toEqual({error:"该记录已存在，请刷新后重试。",code:"ALREADY_EXISTS"});
  });

  it("maps an unknown Error to a generic 500 without leaking the raw message",async()=>{
    const spy=vi.spyOn(console,"error").mockImplementation(()=>{});
    const response=await handle(async()=>{throw new Error("connection string postgresql://synthetic.invalid/nova leaked");});
    expect(response.status).toBe(500);
    const payload=await parse(response);
    expect(payload).toEqual({error:"暂时无法完成操作，请稍后重试。",code:"INTERNAL_ERROR"});
    expect(JSON.stringify(payload)).not.toContain("postgresql");
    expect(JSON.stringify(payload)).not.toContain("leaked");
    expect(spy).toHaveBeenCalled();
  });
});
