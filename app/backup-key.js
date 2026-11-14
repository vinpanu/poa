// Vince's backup key page (POABUILD-52): makes a P-256 key pair in this browser and shows it. Nothing is stored or sent.
import { newKeyPair } from "./backup_crypto.js";

const $ = (id) => document.getElementById(id);
$("make").addEventListener("click", async () => {
  const { publicJwk, privateJwk } = await newKeyPair();
  $("private-key").value = JSON.stringify(privateJwk);
  $("public-key").value = JSON.stringify(publicJwk);
  $("private").hidden = false;
  $("make").disabled = true;
});
$("saved").addEventListener("change", () => { $("public").hidden = !$("saved").checked; });
for (const [button, box] of [["copy-private", "private-key"], ["copy-public", "public-key"]]) {
  $(button).addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($(box).value); $(button).textContent = "Copied"; }
    catch { $(box).select(); $(button).textContent = "Selected: copy it now"; }
  });
}
