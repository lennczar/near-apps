import { Context, Storage, ContractPromise, ContractPromiseResult, PersistentUnorderedMap, u128, logging } from 'near-sdk-as';
import { Buffer } from 'assemblyscript-json/util';

// whitelist uses permission levels
// "untrusted"  (default, contract is unsafe)
// "trusted"    (contract only: contract is safe)
// "admin"      (user only: can edit whitelist)
// note: permission levels do *not* include lower ones
const whitelist = new PersistentUnorderedMap<string, string>('x');
whitelist.set(Context.contractName, "admin");

export function init(account_ids: string[]): void {

    assert(Storage.get<string>("init") == null, "Already initialized");
    
    for (let i = 0; i < account_ids.length; i++)
        whitelist.set(account_ids[i], "admin");

    Storage.set("init", "done");

}

function _has_permission(level: string): void {

    assert(level == "untrusted"
        || level == "trusted"
        || level == "admin",
        `unkonown permission level '${level}'.`
    );

    assert(whitelist.contains(Context.predecessor) 
        && getPermissionLevel(Context.predecessor) == level, 
        `${Context.predecessor} has insufficent permissions.`
    );

}

export function getPermissionLevel(account_id: string = Context.predecessor): string {

    return whitelist.contains(account_id)
        ? whitelist.getSome(account_id)
        : "untrusted";
    
}

export function grantPermissionLevel(account_ids: string[], level: string): void {

    _has_permission("admin");

    assert(level == "untrusted"
        || level == "trusted"
        || level == "admin",
        `unkonown permission level '${level}'.`
    );

    for (let i = 0; i < account_ids.length; i++)
        whitelist.set(account_ids[i], level);

}

export function logCall(
    caller: string[], 
    company: string,
    purpose: string,
    addr: string, 
    func: string, 
    args: string, 
    gas: u64, 
    depo: u128 = u128.Zero
): void {

    assert(getPermissionLevel(addr) == "trusted", `Contract ${addr} is not trusted.`);
    
    const promise = ContractPromise.create(
        addr,
        func,
        Buffer.fromString(args),
        gas,
        depo
    );

    const all_caller: string = caller.join(", ");

    promise.then(
        Context.contractName,
        "_callback",
        Buffer.fromString(`{
            "addr":"${addr}",
            "func":"${func}",
            "caller":["${all_caller}"],
            "company":"${company}",
            "purpose":"${purpose}"
        }`),
        50000000000000 // 50Tgas
    );

}

export function _callback(
    addr: string,
    func: string,
    caller: string[],
    company: string,
    purpose: string
): void {

    const result: ContractPromiseResult = ContractPromise.getResults()[0];

    logging.log(`
        Called method "${func}" of trusted contract "${addr}"
        and ${result.succeeded ? "succedded" : ""}${result.pending ? "is still pending" : ""}${result.failed ? "failed" : ""}
        Result: ${result.succeeded ? result.decode<string>() : "[Error]"}

        Sender: ${Context.sender}
        Caller: ${caller}
        Company: ${company}
        purpose: ${purpose}
    `);

}
