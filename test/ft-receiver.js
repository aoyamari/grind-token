// Test receiver for ft_transfer_call. msg: "keep" -> keep all, "refund" -> return all, "half" -> return half, "fail" -> panic
import { NearBindgen, call, view, near, assert } from 'near-sdk-js';
@NearBindgen({})
class Receiver {
  constructor() { this.received = '0'; }
  @call({})
  ft_on_transfer({ sender_id, amount, msg }) {
    assert(msg !== 'fail', 'receiver failed on purpose');
    const a = BigInt(amount);
    const unused = msg === 'refund' ? a : msg === 'half' ? a / 2n : 0n;
    this.received = (BigInt(this.received) + a - unused).toString();
    near.log(`ft_on_transfer from ${near.predecessorAccountId()} sender=${sender_id} amount=${amount} msg=${msg} unused=${unused}`);
    return unused.toString();
  }
  @view({}) get_received() { return this.received; }
}
