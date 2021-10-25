import { u128 } from "near-sdk-core";

@nearBindgen
export class ContractCall {
    addr: string;
    func: string;
    args: string;
    gas: u64;
    depo: u128;
}