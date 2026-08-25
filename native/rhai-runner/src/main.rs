use rhai::{Array, Dynamic, Engine, EvalAltResult, Map, Scope};
use serde_json::{Map as JsonMap, Number, Value};
use std::io::{self, Read};

const MAX_OPERATIONS: u64 = 100_000;

fn to_dynamic(value: Value) -> Dynamic {
    match value {
        Value::Null => Dynamic::UNIT,
        Value::Bool(value) => Dynamic::from(value),
        Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                Dynamic::from(integer)
            } else {
                Dynamic::from(value.as_f64().unwrap_or_default())
            }
        }
        Value::String(value) => Dynamic::from(value),
        Value::Array(values) => {
            let array: Array = values.into_iter().map(to_dynamic).collect();
            Dynamic::from_array(array)
        }
        Value::Object(values) => {
            let mut map = Map::new();
            for (key, value) in values {
                map.insert(key.into(), to_dynamic(value));
            }
            Dynamic::from_map(map)
        }
    }
}

fn from_dynamic(value: Dynamic) -> Result<Value, String> {
    if value.is_unit() {
        return Ok(Value::Null);
    }
    if let Some(value) = value.clone().try_cast::<bool>() {
        return Ok(Value::Bool(value));
    }
    if let Some(value) = value.clone().try_cast::<i64>() {
        return Ok(Value::Number(Number::from(value)));
    }
    if let Some(value) = value.clone().try_cast::<f64>() {
        let number = Number::from_f64(value).ok_or_else(|| "script returned a non-finite number".to_string())?;
        return Ok(Value::Number(number));
    }
    if let Some(value) = value.clone().try_cast::<String>() {
        return Ok(Value::String(value));
    }
    if let Some(value) = value.clone().try_cast::<Array>() {
        return value.into_iter().map(from_dynamic).collect::<Result<Vec<_>, _>>().map(Value::Array);
    }
    if let Some(value) = value.try_cast::<Map>() {
        let mut object = JsonMap::new();
        for (key, value) in value {
            object.insert(key.into(), from_dynamic(value)?);
        }
        return Ok(Value::Object(object));
    }
    Err("script returned an unsupported value".to_string())
}

fn main() {
    let mut input = String::new();
    if let Err(error) = io::stdin().read_to_string(&mut input) {
        println!("{{\"ok\":false,\"error\":\"failed to read input: {}\"}}", escape(&error.to_string()));
        return;
    }
    let request: Value = match serde_json::from_str(&input) {
        Ok(value) => value,
        Err(error) => {
            println!("{{\"ok\":false,\"error\":\"invalid request: {}\"}}", escape(&error.to_string()));
            return;
        }
    };
    let script = match request.get("script").and_then(Value::as_str) {
        Some(script) if !script.trim().is_empty() => script,
        _ => {
            println!("{{\"ok\":false,\"error\":\"script is empty\"}}");
            return;
        }
    };
    let content = request.get("content").cloned().unwrap_or(Value::Null);

    let mut engine = Engine::new();
    engine.set_max_operations(MAX_OPERATIONS);
    engine.set_max_call_levels(32);
    engine.set_max_array_size(10_000);
    engine.set_max_map_size(10_000);
    engine.set_max_string_size(1_000_000);
    let mut scope = Scope::new();
    let ast = match engine.compile(script) {
        Ok(ast) => ast,
        Err(error) => {
            println!("{}", serde_json::json!({"ok": false, "error": format!("compile error: {}", error)}));
            return;
        }
    };
    let argument = to_dynamic(content);
    let result = match engine.call_fn::<Dynamic>(&mut scope, &ast, "manage", (argument,)) {
        Ok(value) => value,
        Err(error) => {
            print_error("execute", error.as_ref());
            return;
        }
    };
    match from_dynamic(result) {
        Ok(value) => println!("{}", serde_json::json!({"ok": true, "result": value})),
        Err(error) => println!("{}", serde_json::json!({"ok": false, "error": error})),
    }
}

fn print_error(stage: &str, error: &EvalAltResult) {
    println!("{}", serde_json::json!({"ok": false, "error": format!("{} error: {}", stage, error)}));
}

fn escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}
