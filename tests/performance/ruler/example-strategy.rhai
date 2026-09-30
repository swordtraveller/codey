// Example only. Replace this with a user-owned Rhai strategy when comparing policies.
// Available context constants: context::model_max_context, context::model_max_output ().
fn manage(context) {
  let selected = [];
  for message in context.messages {
    if message.role == "system" || message.id == context.runtime.latestUserMessageId {
      selected.push(message);
    }
  }
  selected
}
