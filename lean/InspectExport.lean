import LeanExport.Parse
import Lake.Check.Util
import Lake.Check.Compare
import Lean.Data.Json.FromToJson

open Lean

-- Read data exported from the sandbox, never import the generated module.
partial def collectAxioms (env : LeanExport.ExportedEnv) (todo : List Name)
    (seen : Std.HashSet Name) (found : Array String) : Except String (Array String) := do
  match todo with
  | [] => return found
  | name :: rest =>
    if seen.contains name then return ← collectAxioms env rest seen found
    let some info := env.constMap[name]?
      | throw s!"Missing exported constant: {name}"
    let found := match info with
      | .axiomInfo _ => found.push name.toString
      | _ => found
    let refs := (Lake.Check.runForUsedConsts info fun ref =>
      modify (ref :: ·) : StateM (List Name) Unit).run [] |>.2
    collectAxioms env (refs ++ rest) (seen.insert name) found

def main (args : List String) : IO Unit := do
  let [baselinePath, challengePath, solutionPath] := args
    | throw <| IO.userError "Expected baseline, challenge and solution export paths."
  let parse (path : String) := do
    LeanExport.parseStream (.ofHandle (← IO.FS.Handle.mk path .read))
  let baseline ← parse baselinePath
  let challenge ← parse challengePath
  let env ← parse solutionPath
  -- The model controls its statement too. Never trust its axiom or primitive types.
  let axioms : Array Name := #[`propext, `Classical.choice, `Quot.sound]
  let primitives : Array Name := #[
    `Nat.add, `Nat.sub, `Nat.mul, `Nat.pow, `Nat.gcd, `Nat.div, `Nat.mod,
    `Nat.beq, `Nat.ble, `Nat.land, `Nat.lor, `Nat.xor, `Nat.shiftLeft,
    `Nat.shiftRight, `String.ofList, `Char.ofNat, `List, `eagerReduce,
    `Nat, `String, `String.mk, `Char, `optParam, `autoParam, `semiOutParam,
    `outParam, `Quot, `Quot.mk, `Quot.lift, `Quot.ind]
  IO.ofExcept <| Lake.Check.compareAt baseline challenge axioms #[] primitives
  IO.ofExcept <| Lake.Check.compareAt baseline env axioms #[] primitives
  IO.ofExcept <| Lake.Check.compareAt challenge env
    (#[`brainVatProof] ++ axioms) #[] primitives
  let axioms ← IO.ofExcept <| collectAxioms env [`brainVatProof] {} #[]
  IO.println <| (toJson axioms).compress
