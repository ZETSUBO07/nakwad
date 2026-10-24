/*
 * Runs inside the service worker (imported by sw.js). A file shared to the app with the Android
 * share menu arrives as a POST to /nakwad/share-target: keep it in a cache and open the app with
 * ?shared=1, where src/ui/backup.ts takeSharedFile() picks it up and asks before restoring.
 */
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== "/nakwad/share-target") return;
  event.respondWith((async () => {
    try {
      const data = await event.request.formData();
      const file = data.get("file");
      if (file && typeof file === "object" && file.size <= 500e6) {
        const cache = await caches.open("nakwad-share");
        await cache.put("/nakwad/__shared__", new Response(file, { headers: { "x-file-name": encodeURIComponent(file.name || "") } }));
      }
    } catch (err) {
      console.error(err);
    }
    return Response.redirect("/nakwad/?shared=1", 303);
  })());
});
