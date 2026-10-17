package ai.openbuy.exhibition

import org.json.JSONObject

/** The backend owns availability; the active input may outlive its selectable catalog entry. */
internal object NativeMaterialCatalog {
    fun requireCurrent(state: JSONObject) {
        if (state.optJSONObject("catalog")?.optJSONArray("looks") == null)
            throw ExhibitionApiException("MATERIAL_WORKFLOW_UPGRADE_REQUIRED", "请更新后台以使用自动素材目录。", 426)
    }
    fun looks(state: JSONObject?): List<JSONObject> {
        val all = state?.optJSONObject("catalog")?.optJSONArray("looks") ?: return emptyList()
        return (0 until all.length()).mapNotNull { all.optJSONObject(it) }
    }
    fun hasAlternative(state: JSONObject?): Boolean = looks(state).any { it.optString("id") != state?.optString("selectedLookId") }
    fun next(state: JSONObject?, direction: Int): JSONObject? {
        if (!hasAlternative(state)) return null
        val available = looks(state)
        val current = available.indexOfFirst { it.optString("id") == state?.optString("selectedLookId") }
        val next = if (current < 0) {
            if (direction < 0) available.lastIndex else 0
        } else Math.floorMod(current + direction, available.size)
        return available[next]
    }
    fun selected(state: JSONObject?): JSONObject? = state?.optJSONObject("activeLook")
        ?.takeIf { it.optString("id") == state.optString("selectedLookId") }
        ?: looks(state).firstOrNull { it.optString("id") == state?.optString("selectedLookId") }
}
