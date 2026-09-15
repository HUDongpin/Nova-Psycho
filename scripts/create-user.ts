import {randomUUID} from "node:crypto";
import {z} from "zod";
import {hashPassword} from "../src/lib/auth";
import {query,closeDatabase} from "../src/lib/db";
import {getConfig} from "../src/lib/config";
const input=z.object({username:z.string().trim().toLowerCase().regex(/^[a-z0-9_.@-]{3,100}$/),name:z.string().trim().min(1).max(100),role:z.enum(["admin","staff"]),password:z.string().min(12).max(256)}).parse({username:process.env.NOVA_NEW_USER_USERNAME,name:process.env.NOVA_NEW_USER_NAME,role:process.env.NOVA_NEW_USER_ROLE??"admin",password:process.env.NOVA_NEW_USER_PASSWORD});
try{
  await query("INSERT INTO users(id,region,username,name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)",[randomUUID(),getConfig().region,input.username,input.name,input.role,await hashPassword(input.password)]);
  console.log(`Created a ${input.role} account in ${getConfig().region}. Password not displayed.`);
}finally{delete process.env.NOVA_NEW_USER_PASSWORD;await closeDatabase();}
