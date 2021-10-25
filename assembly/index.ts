import { JSON } from 'assemblyscript-json';
import { Buffer } from 'assemblyscript-json/util';
import { ContractCall } from './model';
import { 
    Context, 
    Storage, 
    ContractPromise,
    ContractPromiseResult, 
    PersistentUnorderedMap, 
    PersistentSet, 
    logging,
    u128
} from 'near-sdk-as';

// whitelist uses permission levels
// "untrusted"  (default, contract is unsafe)
// "trusted"    (contract only: contract is safe)
// "admin"      (user only: can edit whitelist)
// note: permission levels do *not* include lower ones
const whitelist = new PersistentUnorderedMap<string, string>('x');
whitelist.set(Context.contractName, "admin");

const requiredTags = new PersistentSet<string>('y');
let tagsJSON: JSON.Obj;

export function init(account_ids: string[]): void {

    assert(Storage.get<string>("init") == null, "Already initialized");
    
    for (let i = 0; i < account_ids.length; i++)
        whitelist.set(account_ids[i], "admin");

    Storage.set("init", "done");
    Storage.set("trust", "trusted");

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

export function setTrustLevel(level: string): void {

    assert(level == "trusted"
        || level == "all",
        `unkonown permission level "${level}". Please choose "trusted" or "all".`
    );

    Storage.set("trust", level)
    logging.log(`Trust level was set to "${level}"`);

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

export function setRequiredTags(tagNames: string[]): void {

    _has_permission("admin");

    requiredTags.clear();

    for (let i = 0; i < tagNames.length; i++)
        requiredTags.add(tagNames[i]);

}

export function getRequiredTags(): string {

    return requiredTags.values().join(", ");

}

export function addRequiredTags(tagNames: string[]): void {

    _has_permission("admin");

    for (let i = 0; i < tagNames.length; i++)
        requiredTags.add(tagNames[i]);

}

export function removeRequiredTags(tagNames: string[]): void {

    _has_permission("admin");

    for (let i = 0; i < tagNames.length; i++)
        if (requiredTags.has(tagNames[i]))
            requiredTags.delete(tagNames[i]);

}

function _toOrdinaryString(strOrNull: JSON.Str | null): string {

    assert(strOrNull != null, `string from JSON Object was null.`);
    if (strOrNull != null)
        return <string> strOrNull.valueOf();
    return "[ShouldNeverHappen]";

}

export function logCall(
    tags: string,
    calls: ContractCall[]
): void {

    // make sure calls is valid

    assert(calls.length > 0, `Calls array cannot be empty.`);

    for (let i = 0; i < calls.length; i++) {

        assert(getPermissionLevel(calls[i].addr) == "trusted" 
            || Storage.get<string>("trust") == "all", 
            `Contract ${calls[i].addr} is not trusted.`
        );

    }

    assert(u128.le(calls[0].depo, Context.accountBalance), `Insufficient funds.`);

    // make sure tags are valid & complete

    tagsJSON = <JSON.Obj>(JSON.parse(tags));

    const includedButNotRequired: string[] = tagsJSON.keys.filter(t => !requiredTags.has(t)),
          requiredButNotIncluded: string[] = requiredTags.values().filter(t => !tagsJSON.valueOf().has(t));

    assert(includedButNotRequired.length == 0, `Tag(s) ${includedButNotRequired.join(", ")} specified but not required.`);
    assert(requiredButNotIncluded.length == 0, `Required tag(s) ${requiredButNotIncluded.join(", ")} missing.`);

    for (let i = 0; i <  tagsJSON.keys.length; i++) {
    
        const stringOrNull: JSON.Str | null = tagsJSON.getString(tagsJSON.keys[i]); 
        assert(stringOrNull != null, `Specified tag ${tagsJSON.keys[i]} is of value null.`);
    
    }
        
    let promise = ContractPromise.create(
        calls[0].addr,
        calls[0].func,
        Buffer.fromString(calls[0].args),
        calls[0].gas,
        calls[0].depo
    );

    let allPromises: ContractPromise[] = [promise];

    let addrStr: string = `"${calls[0].addr}"`;
    let funcStr: string = `"${calls[0].func}"`;
    for (let i = 1; i < calls.length; i++) {

        addrStr += `,"${calls[i].addr}"`;
        funcStr += `,"${calls[i].func}"`;

        promise = promise.then(
            calls[i].addr,
            calls[i].func,
            Buffer.fromString(calls[i].args),
            calls[i].gas,
            calls[i].depo
        );

        allPromises.push(promise);

    }

    ContractPromise.all(allPromises).then(
        Context.contractName,
        "_callback",
        Buffer.fromString(`{
            "addr":[${addrStr}],
            "func":[${funcStr}],
            "tags":"${tags.replaceAll("\"", "\\\"")}"
        }`),
        50000000000000, // 50Tgas
        u128.Zero
    );

}

export function _callback(
    addr: string[],
    func: string[],
    tags: string
): void {

    const results: ContractPromiseResult[] = ContractPromise.getResults();

    logging.log(`Sender "${Context.sender}" called ${results.length} functions:`);

    tagsJSON = <JSON.Obj>(JSON.parse(tags));
    const tagsString: string = tagsJSON.keys
        .map<string>(t => `${t}: ${_toOrdinaryString(tagsJSON.getString(t))}`)
        .join(",\n");

    for (let i = 0; i < results.length; i++) {

        const state: string = `${results[i].succeeded ? "succeeded" : ""}${results[i].pending ? "is still pending" : ""}${results[i].failed ? "failed" : ""}`;
        const trusted: string = Storage.get<string>("trust") == "trusted" 
            ? "trusted " 
            : "";
        
        // TODO what if result is JSON?
        logging.log(`
    Called method "${func[i]}" of ${trusted}contract "${addr[i]}" and ${state}
    Result: ${results[i].succeeded ? results[i].decode<string>() : "[Error]"}`);

    }

    logging.log(`\n${tagsString}`);

}
