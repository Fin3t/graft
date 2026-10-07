using UnityEngine;
using UnityEngine.SceneManagement;
namespace Game
{
    public class Spawner : MonoBehaviour
    {
        [SerializeField] private GameObject walkerPrefab;
        private static readonly int AttackId = Animator.StringToHash("Attack");
        private const string IconFolder = "Icons/";

        void Start()
        {
            GetComponent<Animator>().SetTrigger(AttackId);
            var icon = Resources.Load<Texture2D>(IconFolder + "a");
            var all = Resources.LoadAll<Texture2D>("Icons");
            var glow = Shader.Find("Custom/Glow");
            SceneManager.LoadScene("Level");
            var m = GetComponent<Renderer>().material;
            m.SetFloat("_Glow", 1f);
            if (gameObject.CompareTag("Player")) { }
            var enemy = LayerMask.NameToLayer("Enemy");
            Invoke(nameof(Later), 1f);
            SendMessage("Footstep");
        }
        void Later() { }
    }
}
