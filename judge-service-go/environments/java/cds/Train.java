import com.google.gson.*;
import com.google.gson.reflect.TypeToken;
import com.google.gson.stream.JsonReader;
import java.io.*;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.stream.*;

// Run once while the image is built, to record which JDK and Gson classes a typical judged
// program loads; those classes are then stored in a class-data archive (run.jsa) so each run
// starts faster (JUDGE_FIX_PLAN T8). It mirrors what the wrappers (pkg/wrappers/java_*.tpl)
// and ordinary student code use: Gson parsing and printing, reflection, Base64, stdin
// readers, collections, streams, strings and exceptions. It never runs in the sandbox.
public class Train {
    public static int[] twoSum(int[] nums, int target) {
        Map<Integer, Integer> seen = new HashMap<>();
        for (int i = 0; i < nums.length; i++) {
            Integer j = seen.get(target - nums[i]);
            if (j != null) return new int[]{j, i};
            seen.put(nums[i], i);
        }
        return new int[0];
    }

    public static void main(String[] args) throws Exception {
        Gson gson = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();
        String json = new String(Base64.getDecoder().decode(Base64.getEncoder().encodeToString(
            "{\"inputs\":[[2,7,11,15],9,\"text\",null,true,1.5]}".getBytes(StandardCharsets.UTF_8))), StandardCharsets.UTF_8);
        JsonObject obj = JsonParser.parseString(json).getAsJsonObject();
        JsonArray inputs = obj.getAsJsonArray("inputs");
        int[] nums = gson.fromJson(inputs.get(0), int[].class);
        int target = inputs.get(1).getAsInt();
        List<List<Integer>> nested = gson.fromJson("[[1,2],[3]]", new TypeToken<List<List<Integer>>>() {}.getType());
        Map<String, Object> map = gson.fromJson("{\"a\":1}", new TypeToken<Map<String, Object>>() {}.getType());
        JsonReader reader = new JsonReader(new StringReader("[1,2,3]"));
        reader.beginArray();
        while (reader.hasNext()) reader.nextInt();
        reader.endArray();

        Method m = Train.class.getMethod("twoSum", int[].class, int.class);
        Object out = m.invoke(null, nums, target);
        StringWriter sw = new StringWriter();
        try {
            Object bad = null;
            bad.toString();
        } catch (Exception e) {
            e.printStackTrace(new PrintWriter(sw));
        }

        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        Scanner sc = new Scanner("3\n1 2 3\nhello world\n");
        int n = sc.nextInt();
        long sum = 0;
        for (int i = 0; i < n; i++) sum += sc.nextLong();
        sc.nextLine();
        String line = sc.nextLine();
        StringTokenizer st = new StringTokenizer(line);
        while (st.hasMoreTokens()) st.nextToken();
        String br1 = br.readLine();

        List<Integer> list = new ArrayList<>(Arrays.asList(5, 3, 1, 4));
        Collections.sort(list);
        Deque<Integer> dq = new ArrayDeque<>(list);
        PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[0] - b[0]);
        pq.add(new int[]{2, 1});
        TreeMap<String, Integer> tm = new TreeMap<>(Map.of("b", 2, "a", 1));
        Set<Long> hs = new HashSet<>(List.of(1L, 2L));
        LinkedList<Character> ll = new LinkedList<>(List.of('x', 'y'));
        String joined = list.stream().map(String::valueOf).collect(Collectors.joining(","));
        int[] arr = IntStream.range(0, 10).filter(i -> i % 2 == 0).toArray();
        Arrays.sort(arr);
        StringBuilder sb = new StringBuilder();
        sb.append(String.format("%d %.2f %s", n, 1.5, joined)).reverse();

        PrintWriter pw = new PrintWriter(new BufferedWriter(new OutputStreamWriter(System.out)));
        pw.println(gson.toJson(out) + " " + gson.toJson(nested) + " " + gson.toJson(map) + " " + sum + " "
            + dq.peekFirst() + " " + pq.peek()[0] + " " + tm.firstKey() + " " + hs.size() + " " + ll.size()
            + " " + arr.length + " " + sb.length() + " " + sw.toString().length() + " " + br1);
        pw.flush();
        System.err.println(gson.toJson(Collections.singletonMap("test", 1)));
    }
}
