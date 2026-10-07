using UnityEditor;
// Unity -batchmode -executeMethod Game.EditorTools.Builder.Run
namespace Game.EditorTools
{
    public static class Builder
    {
        [MenuItem("Tools/Build Stuff")]
        public static void BuildStuff() { var p = AssetDatabase.LoadAssetAtPath<UnityEngine.GameObject>("Assets/Prefabs/Walker.prefab"); }
        public static void Run() { }
    }
}
