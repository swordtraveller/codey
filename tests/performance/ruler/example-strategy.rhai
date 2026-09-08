// Example only. Replace this with a user-owned Rhai strategy when comparing policies.
fn manage(content) {
  let selected = [];
  for message in content.messages {
    if message.role == "system" || message.id == content.runtime.latestUserMessageId {
      selected.push(message);
    }
  }
  selected
}
