import { JSON } from 'assemblyscript-json';
import { Buffer } from 'assemblyscript-json/util';
import { ContractCall } from './model';
import { 
    Context, 
    Storage, 
    ContractPromise, 
    ContractPromiseBatch, 
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
    batch: ContractCall[]
): void {

    // make sure batch is valid

    assert(batch.length > 0, `Calls array cannot be empty.`);

    let  totalDesposit: u128 = u128.Zero;
    for (let i = 0; i < batch.length; i++) {

        assert(batch[i].addr == batch[0].addr, `Cannot batch transactions with different target address.`);
        assert(getPermissionLevel(batch[i].addr) == "trusted" 
            || Storage.get<string>("trust") == "all", 
            `Contract ${batch[i].addr} is not trusted.`
        );

        totalDesposit = u128.add(totalDesposit, batch[i].depo);

    }

    assert(u128.le(totalDesposit, Context.accountBalance), `Insufficient funds.`);

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
    
    if (batch.length == 1) {
    
        const promise = ContractPromise.create(
            batch[0].addr,
            batch[0].func,
            Buffer.fromString(batch[0].args),
            batch[0].gas,
            batch[0].depo
        );

        promise.then(
            Context.contractName,
            "_callback",
            Buffer.fromString(`{
                "addr":"${batch[0].addr}",
                "func":"${batch[0].func}",
                "tags":"${tags.replaceAll("\"", "\\\"")}"
            }`),
            50000000000000 // 50Tgas
        );

    } else if (batch.length > 1) {

        const promise = ContractPromiseBatch.create(batch[0].addr).function_call(
            batch[0].func,
            Buffer.fromString(batch[0].args),
            batch[0].depo,
            batch[0].gas
        );

        for (let i = 1; i < batch.length; i++)
            promise.function_call(
                batch[i].func,
                Buffer.fromString(batch[i].args),
                batch[i].depo,
                batch[i].gas
            );

        promise.then(Context.contractName).function_call(
            "_callback",
            Buffer.fromString(`{
                "addr":"${batch[0].addr}",
                "func":"${batch[0].func}",
                "tags":"${tags.replaceAll("\"", "\\\"")}"
            }`),
            u128.Zero,
            50000000000000, // 50Tgas
        );

    }

}

export function _callback(
    addr: string,
    func: string,
    tags: string
): void {

    const results: ContractPromiseResult[] = ContractPromise.getResults();

    tagsJSON = <JSON.Obj>(JSON.parse(tags));
    const tagsString: string = tagsJSON.keys
        .map<string>(t => `${t}: ${_toOrdinaryString(tagsJSON.getString(t))}`)
        .join(",\n\t");

    for (let i = 0; i < results.length; i++) {

        const state: string = `${results[i].succeeded ? "succeeded" : ""}${results[i].pending ? "is still pending" : ""}${results[i].failed ? "failed" : ""}`;
        const trusted: string = Storage.get<string>("trust") == "trusted" 
            ? "trusted " 
            : "";
        const method: string = results.length == 1 
            ? "\"" + func + "\"" 
            : "";
        
        // TODO what if result is JSON?
        logging.log(`
            Called method ${method} of ${trusted}contract "${addr}" and ${state}
            Result: ${results[i].succeeded ? results[i].decode<string>() : "[Error]"}
            Sender: ${Context.sender}

            ${tagsString}\n\n
        `);

    }

}
